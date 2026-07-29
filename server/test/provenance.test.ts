import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
import {
  diffSnapshots,
  scanSandbox,
  type Snapshot,
} from "../src/provenance/scanner.ts";
import {
  appendStep,
  boundStep,
  identify,
  MAX_EDGES_PER_STEP,
  PROVENANCE_SCHEMA_VERSION,
  readProjectSteps,
  readSteps,
  sha256File,
  stepsPath,
  type ArtifactRef,
  type ProvenanceStep,
} from "../src/provenance/store.ts";
import { ProvenanceRecorder } from "../src/provenance/recorder.ts";
import { artifactProvenance } from "../src/provenance/lookup.ts";

const PROJECT = "prov-test";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.mkdirSync(sandbox(), { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function sandbox(): string {
  return resolvePaths(PROJECT).sandbox;
}

function write(rel: string, content: string): string {
  const abs = path.join(sandbox(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

const ref = (over: Partial<ArtifactRef> = {}): ArtifactRef => ({
  path: "fig.png",
  size: 10,
  mtimeMs: 1_000,
  change: "created",
  confidence: "observed",
  ...over,
});

const step = (over: Partial<ProvenanceStep> = {}): ProvenanceStep => ({
  schemaVersion: PROVENANCE_SCHEMA_VERSION,
  id: "tc_1",
  sessionId: "sess-a",
  timestamp: 1_000,
  toolName: "bash",
  role: "agent",
  inputs: [],
  outputs: [],
  ...over,
});

// --- synthetic Pi events ---------------------------------------------------

function startEvent(toolCallId: string, toolName: string, args: unknown): AgentSessionEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args } as AgentSessionEvent;
}

function endEvent(toolCallId: string, toolName: string, isError = false): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    isError,
    result: { content: [{ type: "text", text: "ok" }] },
  } as AgentSessionEvent;
}

function recorder(over: { runId?: string; model?: string } = {}) {
  return new ProvenanceRecorder({
    projectId: PROJECT,
    sessionId: "sess-a",
    sandboxRoot: sandbox(),
    runId: over.runId ?? "run_abc",
    getModel: () => over.model ?? "openrouter/anthropic/claude-opus-4",
  });
}

// ---------------------------------------------------------------------------

describe("provenance store", () => {
  it("hashes a file and reports a stable digest", () => {
    const abs = write("a.txt", "hello");
    // sha256("hello")
    expect(sha256File(abs)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns null hashing a missing file rather than throwing", () => {
    expect(sha256File(path.join(sandbox(), "nope.txt"))).toBeNull();
  });

  it("identify() returns size, mtime and hash for a regular file", () => {
    const abs = write("b.txt", "xyz");
    const id = identify(abs);
    expect(id?.size).toBe(3);
    expect(id?.sha256).toHaveLength(64);
    expect(id?.hashSkipped).toBeUndefined();
  });

  it("identify() returns null for a directory", () => {
    fs.mkdirSync(path.join(sandbox(), "d"), { recursive: true });
    expect(identify(path.join(sandbox(), "d"))).toBeNull();
  });

  it("round-trips steps through JSONL", () => {
    appendStep(step({ id: "tc_1" }), PROJECT);
    appendStep(step({ id: "tc_2", timestamp: 2_000 }), PROJECT);
    expect(readSteps("sess-a", PROJECT).map((s) => s.id)).toEqual(["tc_1", "tc_2"]);
  });

  it("skips malformed and future-schema rows instead of throwing", () => {
    appendStep(step({ id: "ok" }), PROJECT);
    const file = stepsPath("sess-a", PROJECT);
    fs.appendFileSync(file, "{not json\n", "utf-8");
    fs.appendFileSync(
      file,
      JSON.stringify({ ...step({ id: "future" }), schemaVersion: 99 }) + "\n",
      "utf-8",
    );
    expect(readSteps("sess-a", PROJECT).map((s) => s.id)).toEqual(["ok"]);
  });

  it("merges every session's steps in timestamp order for the project view", () => {
    appendStep(step({ sessionId: "sess-b", id: "later", timestamp: 5_000 }), PROJECT);
    appendStep(step({ sessionId: "sess-a", id: "earlier", timestamp: 1_000 }), PROJECT);
    expect(readProjectSteps(PROJECT).map((s) => s.id)).toEqual(["earlier", "later"]);
  });

  it("returns [] when the project has no provenance directory", () => {
    expect(readProjectSteps("never-ran")).toEqual([]);
  });

  it("caps edges per step and reports how many were dropped", () => {
    const many = Array.from({ length: MAX_EDGES_PER_STEP + 25 }, (_, i) =>
      ref({ path: `out_${i}.txt` }),
    );
    const bounded = boundStep(step({ outputs: many, inputs: [ref({ path: "in.txt" })] }));
    expect(bounded.outputs).toHaveLength(MAX_EDGES_PER_STEP);
    // Outputs are the point of the record, so inputs yield first.
    expect(bounded.inputs).toHaveLength(0);
    expect(bounded.truncatedEdges).toBe(26);
  });

  it("truncates oversized args to a preview", () => {
    const bounded = boundStep(step({ args: { blob: "x".repeat(20_000) } }));
    expect((bounded.args as { truncated?: boolean }).truncated).toBe(true);
  });

  it("leaves small args untouched", () => {
    const bounded = boundStep(step({ args: { path: "a.py" } }));
    expect(bounded.args).toEqual({ path: "a.py" });
  });

  it("rejects a traversal-shaped session id", () => {
    expect(() => stepsPath("../escape", PROJECT)).toThrow(/Invalid session id/);
  });
});

describe("provenance scanner", () => {
  it("stats user-visible files and skips dot-dirs and node_modules", async () => {
    write("keep.txt", "a");
    write("sub/keep2.txt", "b");
    write(".kady/hidden.jsonl", "c");
    write(".pi/sessions/s.jsonl", "d");
    write("node_modules/pkg/index.js", "e");
    // Hidden by USER_HIDDEN_NAMES even outside a dot-dir.
    write("AGENTS.md", "f");
    const { snapshot, degraded } = await scanSandbox(sandbox());
    expect(degraded).toBeUndefined();
    expect([...snapshot.keys()].sort()).toEqual(["keep.txt", "sub/keep2.txt"]);
  });

  it("degrades rather than returning a partial snapshot as authoritative", async () => {
    write("a.txt", "1");
    write("b.txt", "2");
    write("c.txt", "3");
    const { degraded } = await scanSandbox(sandbox(), 2);
    expect(degraded).toBe("sandbox-too-large");
  });

  it("emits wire-format (forward slash) relative paths", async () => {
    write("nested/deep/f.csv", "x");
    const { snapshot } = await scanSandbox(sandbox());
    expect([...snapshot.keys()]).toContain("nested/deep/f.csv");
  });

  it("diffs created, modified and deleted", () => {
    const before: Snapshot = new Map([
      ["same.txt", { size: 1, mtimeMs: 10 }],
      ["changed.txt", { size: 1, mtimeMs: 10 }],
      ["gone.txt", { size: 1, mtimeMs: 10 }],
    ]);
    const after: Snapshot = new Map([
      ["same.txt", { size: 1, mtimeMs: 10 }],
      ["changed.txt", { size: 2, mtimeMs: 20 }],
      ["new.txt", { size: 5, mtimeMs: 30 }],
    ]);
    expect(diffSnapshots(before, after)).toEqual({
      created: ["new.txt"],
      modified: ["changed.txt"],
      deleted: ["gone.txt"],
    });
  });

  it("treats an mtime-only change as modified", () => {
    const before: Snapshot = new Map([["f.txt", { size: 3, mtimeMs: 10 }]]);
    const after: Snapshot = new Map([["f.txt", { size: 3, mtimeMs: 99 }]]);
    expect(diffSnapshots(before, after).modified).toEqual(["f.txt"]);
  });
});

describe("provenance recorder", () => {
  it("records a declared write as an observed output edge with a hash", async () => {
    const rec = recorder();
    rec.observe(startEvent("tc_w", "write", { path: "de_analysis.py" }));
    write("de_analysis.py", "print(1)");
    rec.observe(endEvent("tc_w", "write"));
    await rec.flush();

    const steps = readSteps("sess-a", PROJECT);
    expect(steps).toHaveLength(1);
    expect(steps[0].toolName).toBe("write");
    expect(steps[0].runId).toBe("run_abc");
    expect(steps[0].model).toBe("openrouter/anthropic/claude-opus-4");
    expect(steps[0].outputs).toHaveLength(1);
    expect(steps[0].outputs[0]).toMatchObject({
      path: "de_analysis.py",
      change: "created",
      confidence: "observed",
    });
    expect(steps[0].outputs[0].sha256).toHaveLength(64);
  });

  it("records a read as an observed input edge", async () => {
    write("counts.csv", "a,b\n1,2\n");
    const rec = recorder();
    rec.observe(startEvent("tc_r", "read", { path: "counts.csv" }));
    rec.observe(endEvent("tc_r", "read"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.inputs).toHaveLength(1);
    expect(row.inputs[0]).toMatchObject({
      path: "counts.csv",
      change: "read",
      confidence: "observed",
    });
    expect(row.outputs).toEqual([]);
  });

  it("attributes a file written by bash via the scan diff", async () => {
    const rec = recorder();
    // Let the baseline walk settle so the write is seen as new.
    await rec.flush();
    rec.observe(startEvent("tc_b", "bash", { command: "python de_analysis.py" }));
    write("figure_3.png", "PNGDATA");
    rec.observe(endEvent("tc_b", "bash"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.outputs.map((o) => o.path)).toEqual(["figure_3.png"]);
    expect(row.outputs[0].confidence).toBe("observed");
    expect(row.outputs[0].change).toBe("created");
  });

  it("records a bash deletion against the pre-scan snapshot", async () => {
    write("scratch.txt", "temp");
    const rec = recorder();
    await rec.flush();
    rec.observe(startEvent("tc_d", "bash", { command: "rm scratch.txt" }));
    fs.rmSync(path.join(sandbox(), "scratch.txt"));
    rec.observe(endEvent("tc_d", "bash"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.outputs).toHaveLength(1);
    expect(row.outputs[0]).toMatchObject({ path: "scratch.txt", change: "deleted" });
    // Size came from the snapshot, since the file is gone.
    expect(row.outputs[0].size).toBe(4);
  });

  it("does not re-attribute a declared write to a later bash step", async () => {
    const rec = recorder();
    await rec.flush();
    rec.observe(startEvent("tc_w", "write", { path: "model.py" }));
    write("model.py", "x = 1");
    rec.observe(endEvent("tc_w", "write"));
    await rec.flush();

    rec.observe(startEvent("tc_b", "bash", { command: "echo hi" }));
    rec.observe(endEvent("tc_b", "bash"));
    await rec.flush();

    const steps = readSteps("sess-a", PROJECT);
    expect(steps[0].outputs.map((o) => o.path)).toEqual(["model.py"]);
    expect(steps[1].outputs).toEqual([]);
  });

  it("downgrades to inferred when a later step finished before the scan ran", async () => {
    const rec = recorder();
    await rec.flush();
    // Both tool calls end before the drain gets to the first one's scan, which
    // is exactly the misattribution window.
    rec.observe(startEvent("tc_1", "bash", { command: "python a.py" }));
    rec.observe(endEvent("tc_1", "bash"));
    rec.observe(startEvent("tc_2", "bash", { command: "python b.py" }));
    rec.observe(endEvent("tc_2", "bash"));
    write("out.csv", "1");
    await rec.flush();

    const steps = readSteps("sess-a", PROJECT);
    const edges = steps.flatMap((s) => s.outputs);
    expect(edges).toHaveLength(1);
    expect(edges[0].path).toBe("out.csv");
    expect(edges[0].confidence).toBe("inferred");
  });

  it("skips the scan entirely for known read-only tools", async () => {
    const rec = recorder();
    await rec.flush();
    rec.observe(startEvent("tc_s", "web_search", { query: "deseq2" }));
    // A file appearing concurrently must not be blamed on web_search.
    write("unrelated.txt", "x");
    rec.observe(endEvent("tc_s", "web_search"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.outputs).toEqual([]);
    expect(row.inputs).toEqual([]);
  });

  it("ignores a failed declared write", async () => {
    const rec = recorder();
    rec.observe(startEvent("tc_f", "write", { path: "nope.py" }));
    rec.observe(endEvent("tc_f", "write", true));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.isError).toBe(true);
    expect(row.outputs).toEqual([]);
  });

  it("never records an edge for a path outside the sandbox", async () => {
    const rec = recorder();
    rec.observe(startEvent("tc_e", "read", { path: "/etc/passwd" }));
    rec.observe(endEvent("tc_e", "read"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.inputs).toEqual([]);
  });

  it("relativizes absolute sandbox paths in stored args", async () => {
    const abs = write("script.py", "pass");
    const rec = recorder();
    rec.observe(startEvent("tc_a", "read", { path: abs }));
    rec.observe(endEvent("tc_a", "read"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect((row.args as { path: string }).path).toBe("script.py");
    expect(JSON.stringify(row.args)).not.toContain(sandbox());
  });
});

describe("artifact provenance lookup", () => {
  it("reports the producing step and a current hash as current", async () => {
    const rec = recorder();
    rec.observe(startEvent("tc_w", "write", { path: "fig.png" }));
    write("fig.png", "PNG");
    rec.observe(endEvent("tc_w", "write"));
    await rec.flush();

    const result = artifactProvenance(PROJECT, "fig.png");
    expect(result.exists).toBe(true);
    expect(result.producedBy.map((s) => s.id)).toEqual(["tc_w"]);
    expect(result.staleness).toBe("current");
  });

  it("flags an artifact changed after the step that produced it as stale", async () => {
    const rec = recorder();
    rec.observe(startEvent("tc_w", "write", { path: "fig.png" }));
    write("fig.png", "PNG");
    rec.observe(endEvent("tc_w", "write"));
    await rec.flush();

    write("fig.png", "DIFFERENT BYTES");
    expect(artifactProvenance(PROJECT, "fig.png").staleness).toBe("stale");
  });

  it("reports unknown staleness when nothing produced the file", () => {
    write("uploaded.csv", "a,b\n");
    const result = artifactProvenance(PROJECT, "uploaded.csv");
    expect(result.producedBy).toEqual([]);
    expect(result.staleness).toBe("unknown");
  });

  it("lists newest producing step first", () => {
    appendStep(
      step({ id: "old", timestamp: 1_000, outputs: [ref({ path: "fig.png" })] }),
      PROJECT,
    );
    appendStep(
      step({ id: "new", timestamp: 9_000, outputs: [ref({ path: "fig.png" })] }),
      PROJECT,
    );
    write("fig.png", "PNG");
    expect(artifactProvenance(PROJECT, "fig.png").producedBy.map((s) => s.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("separates reads from writes and caps the read list", () => {
    appendStep(
      step({ id: "w", timestamp: 1_000, outputs: [ref({ path: "counts.csv" })] }),
      PROJECT,
    );
    for (let i = 0; i < 30; i++) {
      appendStep(
        step({
          id: `r${i}`,
          timestamp: 2_000 + i,
          toolName: "read",
          inputs: [ref({ path: "counts.csv", change: "read" })],
        }),
        PROJECT,
      );
    }
    write("counts.csv", "a,b\n");
    const result = artifactProvenance(PROJECT, "counts.csv");
    expect(result.producedBy.map((s) => s.id)).toEqual(["w"]);
    expect(result.readByTotal).toBe(30);
    expect(result.readBy).toHaveLength(20);
    // Newest first.
    expect(result.readBy[0].id).toBe("r29");
  });

  it("flags a notebook citation written before the artifact's latest version", () => {
    appendNotebookEntry(
      "sess-a",
      {
        id: "nb_1",
        type: "observation",
        title: "Six clusters visible",
        timestamp: 1_000,
        role: "agent",
        artifacts: ["fig.png"],
      },
      PROJECT,
    );
    appendStep(
      step({ id: "regen", timestamp: 5_000, outputs: [ref({ path: "fig.png" })] }),
      PROJECT,
    );
    write("fig.png", "PNG");

    const [citation] = artifactProvenance(PROJECT, "fig.png").citedBy;
    expect(citation.id).toBe("nb_1");
    expect(citation.precedesLatestOutput).toBe(true);
  });

  it("does not flag a citation written after the latest version", () => {
    appendStep(
      step({ id: "gen", timestamp: 1_000, outputs: [ref({ path: "fig.png" })] }),
      PROJECT,
    );
    appendNotebookEntry(
      "sess-a",
      {
        id: "nb_2",
        type: "observation",
        title: "Six clusters visible",
        timestamp: 5_000,
        role: "agent",
        artifacts: ["fig.png"],
      },
      PROJECT,
    );
    write("fig.png", "PNG");
    expect(artifactProvenance(PROJECT, "fig.png").citedBy[0].precedesLatestOutput).toBe(false);
  });

  it("normalizes an unusual spelling of the same path", () => {
    appendStep(step({ id: "gen", outputs: [ref({ path: "sub/fig.png" })] }), PROJECT);
    write("sub/fig.png", "PNG");
    expect(artifactProvenance(PROJECT, "./sub/fig.png").producedBy.map((s) => s.id)).toEqual([
      "gen",
    ]);
  });

  it("reports a deleted artifact as no longer existing", () => {
    appendStep(
      step({ id: "gen", outputs: [ref({ path: "gone.png", change: "deleted" })] }),
      PROJECT,
    );
    const result = artifactProvenance(PROJECT, "gone.png");
    expect(result.exists).toBe(false);
    expect(result.current).toBeNull();
  });

  it("refuses a path outside the sandbox", () => {
    expect(() => artifactProvenance(PROJECT, "../../etc/passwd")).toThrow(/not a user-visible/);
  });

  it("refuses a hidden internal path", () => {
    expect(() => artifactProvenance(PROJECT, ".kady/provenance/x")).toThrow(
      /not a user-visible/,
    );
  });
});
