import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { inferOutputs, provenanceStepsFromSessionFile } from "../src/provenance/harvest.ts";
import {
  appendNewSteps,
  appendStep,
  PROVENANCE_SCHEMA_VERSION,
  readSteps,
  type ProvenanceStep,
} from "../src/provenance/store.ts";
import { artifactProvenance } from "../src/provenance/lookup.ts";

const PROJECT = "harvest-test";
const PARENT = "parent-sess";

function sandbox(): string {
  return resolvePaths(PROJECT).sandbox;
}

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(sandbox(), { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function write(rel: string, content: string): string {
  const abs = path.join(sandbox(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

/** One assistant row carrying a toolCall, as pi writes it. */
function callRow(id: string, name: string, args: unknown, iso: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: iso,
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  });
}

/** The paired toolResult row (epoch-ms timestamp, plus isError). */
function resultRow(id: string, name: string, isError: boolean, epochMs: number): string {
  return JSON.stringify({
    type: "message",
    timestamp: new Date(epochMs).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: isError ? "boom" : "ok" }],
      isError,
      timestamp: epochMs,
    },
  });
}

const T0 = 1_800_000_000_000;
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const harvest = (lines: string[], agent = "data-engineer") =>
  provenanceStepsFromSessionFile(lines.join("\n"), agent, {
    parentSessionId: PARENT,
    sandboxRoot: sandbox(),
    model: "openrouter/anthropic/claude-sonnet-5",
    runId: "run_parent",
  });

describe("subagent provenance harvest", () => {
  it("returns nothing for an empty or unparseable session file", () => {
    expect(harvest([]).steps).toEqual([]);
    expect(harvest(["{not json", ""]).steps).toEqual([]);
  });

  it("records a child write as an observed output hashed at harvest time", () => {
    write("model.py", "x = 1");
    const { steps } = harvest([
      callRow("c1", "write", { path: "model.py", content: "x = 1" }, iso(0)),
      resultRow("c1", "write", false, T0 + 50),
    ]);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.id).toBe("data-engineer:c1");
    expect(step.sessionId).toBe(PARENT);
    expect(step.role).toBe("subagent");
    expect(step.agentName).toBe("data-engineer");
    expect(step.model).toBe("openrouter/anthropic/claude-sonnet-5");
    expect(step.runId).toBe("run_parent");
    expect(step.startedAt).toBe(T0);
    expect(step.timestamp).toBe(T0 + 50);
    expect(step.outputs).toHaveLength(1);
    expect(step.outputs[0]).toMatchObject({
      path: "model.py",
      change: "wrote",
      confidence: "observed",
      identityAt: "harvest",
    });
    expect(step.outputs[0].sha256).toHaveLength(64);
  });

  it("does not claim created or modified, which it cannot know", () => {
    write("f.txt", "a");
    const { steps } = harvest([
      callRow("c1", "write", { path: "f.txt" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    expect(steps[0].outputs[0].change).toBe("wrote");
  });

  it("records a child read as an input edge", () => {
    write("counts.csv", "a,b\n");
    const { steps } = harvest([
      callRow("c1", "read", { path: "counts.csv" }, iso(0)),
      resultRow("c1", "read", false, T0 + 5),
    ]);
    expect(steps[0].inputs).toMatchObject([
      { path: "counts.csv", change: "read", confidence: "observed", identityAt: "harvest" },
    ]);
    expect(steps[0].outputs).toEqual([]);
  });

  it("ignores a failed child write", () => {
    write("f.txt", "a");
    const { steps } = harvest([
      callRow("c1", "write", { path: "f.txt" }, iso(0)),
      resultRow("c1", "write", true, T0 + 10),
    ]);
    expect(steps[0].isError).toBe(true);
    expect(steps[0].outputs).toEqual([]);
  });

  it("marks an opaque child call as having no scan baseline", () => {
    const { steps } = harvest([
      callRow("c1", "bash", { command: "python run.py" }, iso(0)),
      resultRow("c1", "bash", false, T0 + 100),
    ]);
    expect(steps[0].degraded).toBe("no-scan-baseline");
    expect(steps[0].outputs).toEqual([]);
  });

  it("does not degrade a known read-only child call", () => {
    const { steps } = harvest([
      callRow("c1", "web_search", { query: "deseq2" }, iso(0)),
      resultRow("c1", "web_search", false, T0 + 20),
    ]);
    expect(steps[0].degraded).toBeUndefined();
  });

  it("still records the write when the artifact was later deleted", () => {
    const { steps } = harvest([
      callRow("c1", "write", { path: "gone.txt" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    expect(steps[0].outputs).toMatchObject([
      { path: "gone.txt", change: "wrote", hashSkipped: "unreadable" },
    ]);
    expect(steps[0].outputs[0].sha256).toBeUndefined();
  });

  it("refuses a child path outside the sandbox or hidden", () => {
    const { steps } = harvest([
      callRow("c1", "read", { path: "/etc/passwd" }, iso(0)),
      resultRow("c1", "read", false, T0 + 5),
      callRow("c2", "write", { path: ".kady/secret" }, iso(10)),
      resultRow("c2", "write", false, T0 + 15),
    ]);
    expect(steps[0].inputs).toEqual([]);
    expect(steps[1].outputs).toEqual([]);
  });

  it("relativizes absolute sandbox paths in harvested args", () => {
    const abs = write("script.py", "pass");
    const { steps } = harvest([
      callRow("c1", "read", { path: abs }, iso(0)),
      resultRow("c1", "read", false, T0 + 5),
    ]);
    expect((steps[0].args as { path: string }).path).toBe("script.py");
    expect(JSON.stringify(steps[0].args)).not.toContain(sandbox());
  });

  // Children routinely emit the ABSOLUTE host path for a sandbox file. The
  // declared path therefore has to be read after relativization, or the edge is
  // silently dropped and mtime inference has to guess at it instead — which is
  // exactly what happened in the first live subagent run.
  it("records an edge when the child writes via an absolute sandbox path", () => {
    const abs = write("summarize.py", "print(1)");
    const { steps } = harvest([
      callRow("c1", "write", { path: abs, content: "print(1)" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    expect(steps[0].outputs).toMatchObject([
      { path: "summarize.py", change: "wrote", confidence: "observed" },
    ]);
  });

  it("records an input edge when the child reads via an absolute sandbox path", () => {
    const abs = write("counts.csv", "a,b\n");
    const { steps } = harvest([
      callRow("c1", "read", { path: abs }, iso(0)),
      resultRow("c1", "read", false, T0 + 5),
    ]);
    expect(steps[0].inputs).toMatchObject([{ path: "counts.csv", confidence: "observed" }]);
  });

  it("leaves an absolute path outside the sandbox unresolved", () => {
    const { steps } = harvest([
      callRow("c1", "write", { path: "/etc/hosts" }, iso(0)),
      resultRow("c1", "write", false, T0 + 5),
    ]);
    expect(steps[0].outputs).toEqual([]);
  });

  it("lets a declared write win over mtime inference for the same file", () => {
    const abs = write("out.csv", "x");
    const { steps, window } = harvest([
      callRow("c1", "bash", { command: "mkdir -p tmp" }, iso(0)),
      resultRow("c1", "bash", false, T0 + 10),
      callRow("c2", "write", { path: abs }, iso(20)),
      resultRow("c2", "write", false, T0 + 30),
    ]);
    const enriched = inferOutputs(
      steps,
      [{ path: "out.csv", mtimeMs: T0 + 25 }],
      window,
      new Set(),
      sandbox(),
    );
    const edges = enriched.flatMap((s) => s.outputs);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ path: "out.csv", confidence: "observed" });
    // The bash step must not have picked it up by timing.
    expect(enriched.find((s) => s.toolName === "bash")!.outputs).toEqual([]);
  });

  it("reports the child's activity window", () => {
    const { window } = harvest([
      callRow("c1", "read", { path: "a" }, iso(0)),
      resultRow("c1", "read", false, T0 + 100),
      callRow("c2", "bash", { command: "ls" }, iso(500)),
      resultRow("c2", "bash", false, T0 + 900),
    ]);
    expect(window).toEqual({ start: T0, end: T0 + 900 });
  });

  it("namespaces step ids per agent so two children never collide", () => {
    const lines = [
      callRow("same-id", "bash", { command: "ls" }, iso(0)),
      resultRow("same-id", "bash", false, T0 + 10),
    ];
    const a = harvest(lines, "agent-a").steps[0].id;
    const b = harvest(lines, "agent-b").steps[0].id;
    expect(a).toBe("agent-a:same-id");
    expect(b).toBe("agent-b:same-id");
    expect(a).not.toBe(b);
  });
});

describe("mtime-window output inference", () => {
  const opaqueStep = (id: string, ts: number): ProvenanceStep => ({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id,
    sessionId: PARENT,
    timestamp: ts,
    toolName: "bash",
    role: "subagent",
    agentName: "data-engineer",
    inputs: [],
    outputs: [],
    degraded: "no-scan-baseline",
  });

  it("attaches an in-window unclaimed file as an inferred edge", () => {
    write("figure.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("s1", T0 + 100)],
      [{ path: "figure.png", mtimeMs: T0 + 200 }],
      { start: T0, end: T0 + 500 },
      new Set(),
      sandbox(),
    );
    expect(steps[0].outputs).toMatchObject([
      { path: "figure.png", change: "wrote", confidence: "inferred", identityAt: "harvest" },
    ]);
  });

  it("never marks an inferred edge as observed", () => {
    write("f.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("s1", T0)],
      [{ path: "f.png", mtimeMs: T0 + 10 }],
      { start: T0, end: T0 + 100 },
      new Set(),
      sandbox(),
    );
    expect(steps[0].outputs.every((o) => o.confidence === "inferred")).toBe(true);
  });

  it("skips a file already claimed by another step", () => {
    write("figure.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("s1", T0)],
      [{ path: "figure.png", mtimeMs: T0 + 50 }],
      { start: T0, end: T0 + 500 },
      new Set(["figure.png"]),
      sandbox(),
    );
    expect(steps[0].outputs).toEqual([]);
  });

  it("skips a file whose mtime falls outside the window", () => {
    write("before.png", "PNG");
    write("after.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("s1", T0 + 100)],
      [
        { path: "before.png", mtimeMs: T0 - 5_000 },
        { path: "after.png", mtimeMs: T0 + 90_000 },
      ],
      { start: T0, end: T0 + 500 },
      new Set(),
      sandbox(),
    );
    expect(steps[0].outputs).toEqual([]);
  });

  it("attributes to the last opaque call at or before the file's mtime", () => {
    write("late.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("early", T0 + 100), opaqueStep("late", T0 + 400)],
      [{ path: "late.png", mtimeMs: T0 + 450 }],
      { start: T0, end: T0 + 900 },
      new Set(),
      sandbox(),
    );
    expect(steps.find((s) => s.id === "late")!.outputs).toHaveLength(1);
    expect(steps.find((s) => s.id === "early")!.outputs).toEqual([]);
  });

  it("does not infer when the child made no opaque call", () => {
    write("f.png", "PNG");
    const declared: ProvenanceStep = { ...opaqueStep("s1", T0), degraded: undefined };
    const steps = inferOutputs(
      [declared],
      [{ path: "f.png", mtimeMs: T0 + 10 }],
      { start: T0, end: T0 + 100 },
      new Set(),
      sandbox(),
    );
    expect(steps[0].outputs).toEqual([]);
  });

  it("does not infer without a window", () => {
    write("f.png", "PNG");
    const steps = inferOutputs(
      [opaqueStep("s1", T0)],
      [{ path: "f.png", mtimeMs: T0 + 10 }],
      null,
      new Set(),
      sandbox(),
    );
    expect(steps[0].outputs).toEqual([]);
  });
});

describe("harvested steps in the store and lookup", () => {
  it("dedups a re-delivered async completion", () => {
    write("model.py", "x = 1");
    const { steps } = harvest([
      callRow("c1", "write", { path: "model.py" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    expect(appendNewSteps(PARENT, steps, PROJECT)).toHaveLength(1);
    // Same payload delivered twice — and after a restart the in-memory guard is
    // gone, so the log itself has to be the guard.
    expect(appendNewSteps(PARENT, steps, PROJECT)).toHaveLength(0);
    expect(readSteps(PARENT, PROJECT)).toHaveLength(1);
  });

  it("surfaces a subagent as the producing step, with its agent name", () => {
    write("figure.png", "PNG");
    const { steps } = harvest([
      callRow("c1", "write", { path: "figure.png" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    appendNewSteps(PARENT, steps, PROJECT);
    const result = artifactProvenance(PROJECT, "figure.png");
    expect(result.producedBy).toHaveLength(1);
    expect(result.producedBy[0]).toMatchObject({
      role: "subagent",
      agentName: "data-engineer",
    });
  });

  it("refuses to call a harvest-time match 'current'", () => {
    write("figure.png", "PNG");
    const { steps } = harvest([
      callRow("c1", "write", { path: "figure.png" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    appendNewSteps(PARENT, steps, PROJECT);
    // Bytes are identical to the harvested hash, but that hash was taken after
    // the fact, so it cannot certify what the step produced.
    expect(artifactProvenance(PROJECT, "figure.png").staleness).toBe("unknown");
  });

  it("still calls a harvest-time MISmatch stale", () => {
    write("figure.png", "PNG");
    const { steps } = harvest([
      callRow("c1", "write", { path: "figure.png" }, iso(0)),
      resultRow("c1", "write", false, T0 + 10),
    ]);
    appendNewSteps(PARENT, steps, PROJECT);
    write("figure.png", "DIFFERENT");
    expect(artifactProvenance(PROJECT, "figure.png").staleness).toBe("stale");
  });

  it("keeps reporting 'current' for a lead-agent write-time hash", () => {
    write("lead.png", "PNG");
    appendStep(
      {
        schemaVersion: PROVENANCE_SCHEMA_VERSION,
        id: "lead-1",
        sessionId: PARENT,
        timestamp: T0,
        toolName: "write",
        role: "agent",
        inputs: [],
        outputs: [
          {
            path: "lead.png",
            sha256: crypto.createHash("sha256").update("PNG").digest("hex"),
            size: 3,
            mtimeMs: 1,
            change: "created",
            confidence: "observed",
          },
        ],
      },
      PROJECT,
    );
    expect(artifactProvenance(PROJECT, "lead.png").staleness).toBe("current");
  });
});
