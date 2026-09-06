/**
 * Lineage, environment capture, user steps, Modal compute steps, and inferred
 * inputs — the pieces that turn "what produced this file" into "where did it
 * come from, and could I get it again".
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  environmentFingerprint,
  environmentId,
  environmentMayHaveChanged,
  listVenvPackages,
  parseDistInfoName,
  parseRProbe,
  pythonVersionFromPyvenvCfg,
  readEnvironment,
  readGitHead,
  storeEnvironment,
  type EnvironmentSnapshot,
} from "../src/provenance/environment.ts";
import { provenanceStepsFromSessionFile } from "../src/provenance/harvest.ts";
import { artifactProvenance, walkLineage } from "../src/provenance/lookup.ts";
import { mentionedPaths } from "../src/provenance/mentions.ts";
import { modalJobStep } from "../src/provenance/modal-steps.ts";
import { ProvenanceRecorder } from "../src/provenance/recorder.ts";
import {
  appendStep,
  PROVENANCE_SCHEMA_VERSION,
  readSteps,
  sha256File,
  USER_SESSION_ID,
  type ArtifactRef,
  type ProvenanceStep,
} from "../src/provenance/store.ts";
import type { ModalJob } from "../src/modal/types.ts";

const PROJECT = "lineage-test";
const app = await buildApp();

function sandbox(): string {
  return resolvePaths(PROJECT).sandbox;
}

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(PROJECT);
}
beforeEach(reset);
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

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

const fakeEnv = (tag: string): EnvironmentSnapshot => {
  const body = {
    schemaVersion: 1 as const,
    os: { platform: "linux", release: "6.1", arch: "x64" },
    python: { version: "3.12.4", source: "venv" as const, packages: [{ name: tag, version: "1.0" }] },
    lockfiles: [],
  };
  return { ...body, id: environmentId(body), capturedAt: 1 };
};

function inject(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      "x-project-id": PROJECT,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

// ---------------------------------------------------------------------------

describe("command-line input inference", () => {
  const files = new Set(["de_analysis.py", "data/counts.csv", "README.md", "out.csv"]);
  const exists = (rel: string) => files.has(rel);

  it("finds the script and the data a python invocation names", () => {
    expect(mentionedPaths("uv run python de_analysis.py data/counts.csv", exists)).toEqual([
      "data/counts.csv",
      "de_analysis.py",
    ]);
  });

  it("handles quoting, ./ prefixes, redirects, and --flag=path", () => {
    expect(
      mentionedPaths(`python './de_analysis.py' --input="data/counts.csv" > out.csv`, exists),
    ).toEqual(["data/counts.csv", "de_analysis.py", "out.csv"]);
  });

  it("ignores flags, globs, variables, and traversal", () => {
    expect(mentionedPaths("cat *.csv $HOME/x ../README.md --README.md", exists)).toEqual([]);
  });

  it("ignores words that are not files", () => {
    expect(mentionedPaths("python -c 'import pandas; print(1)'", exists)).toEqual([]);
  });
});

describe("environment snapshot", () => {
  it("reads the python version from either pyvenv.cfg spelling", () => {
    expect(pythonVersionFromPyvenvCfg("home = /x\nversion_info = 3.12.4\n")).toBe("3.12.4");
    expect(pythonVersionFromPyvenvCfg("home = /x\nversion = 3.11.9\n")).toBe("3.11.9");
  });

  it("parses dist-info directory names and falls back to METADATA", () => {
    expect(parseDistInfoName("pandas-2.2.2.dist-info")).toEqual({
      name: "pandas",
      version: "2.2.2",
    });
    expect(parseDistInfoName("scikit_learn-1.5.0.dist-info")).toEqual({
      name: "scikit_learn",
      version: "1.5.0",
    });
    expect(parseDistInfoName("weird.dist-info")).toBeNull();

    const venv = path.join(sandbox(), ".venv");
    const site = path.join(venv, "lib", "python3.12", "site-packages");
    fs.mkdirSync(path.join(site, "numpy-2.0.1.dist-info"), { recursive: true });
    fs.mkdirSync(path.join(site, "odd.dist-info"), { recursive: true });
    fs.writeFileSync(
      path.join(site, "odd.dist-info", "METADATA"),
      "Metadata-Version: 2.1\nName: odd-pkg\nVersion: 0.3\n\nBody\n",
    );
    fs.mkdirSync(path.join(site, "numpy"), { recursive: true }); // not a dist-info
    const { packages, truncated } = listVenvPackages(venv);
    expect(packages).toEqual([
      { name: "numpy", version: "2.0.1" },
      { name: "odd-pkg", version: "0.3" },
    ]);
    expect(truncated).toBe(0);
  });

  it("parses the R probe output", () => {
    const r = parseRProbe("R version 4.4.1 (2024-06-14)\nDESeq2==1.44.0\nggplot2==3.5.1\n");
    expect(r?.version).toBe("R version 4.4.1 (2024-06-14)");
    expect(r?.packages).toEqual([
      { name: "DESeq2", version: "1.44.0" },
      { name: "ggplot2", version: "3.5.1" },
    ]);
    expect(parseRProbe("Rscript: command not found")).toBeUndefined();
  });

  it("resolves git HEAD through a loose ref and packed-refs without spawning git", () => {
    const git = path.join(sandbox(), ".git");
    fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(git, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    expect(readGitHead(sandbox())).toBe("a".repeat(40));

    fs.rmSync(path.join(git, "refs", "heads", "main"));
    fs.writeFileSync(path.join(git, "packed-refs"), `# pack-refs\n${"b".repeat(40)} refs/heads/main\n`);
    expect(readGitHead(sandbox())).toBe("b".repeat(40));

    fs.writeFileSync(path.join(git, "HEAD"), `${"c".repeat(40)}\n`);
    expect(readGitHead(sandbox())).toBe("c".repeat(40));
  });

  it("gives identical content an identical id regardless of key order", () => {
    const a = environmentId({
      schemaVersion: 1,
      os: { platform: "linux", release: "6", arch: "x64" },
      lockfiles: [{ path: "uv.lock", sha256: "ff" }],
    });
    const b = environmentId({
      lockfiles: [{ sha256: "ff", path: "uv.lock" }],
      os: { arch: "x64", release: "6", platform: "linux" },
      schemaVersion: 1,
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("stores a snapshot once, content-addressed, and reads it back", () => {
    const env = fakeEnv("pandas");
    storeEnvironment(env, PROJECT);
    storeEnvironment({ ...env, capturedAt: 999 }, PROJECT); // same content, later capture
    const files = fs.readdirSync(resolvePaths(PROJECT).environmentsDir);
    expect(files).toEqual([`${env.id}.json`]);
    expect(readEnvironment(env.id, PROJECT)?.capturedAt).toBe(1);
    expect(readEnvironment("0".repeat(64), PROJECT)).toBeNull();
  });

  it("fingerprints the venv and lockfiles by stat, ignoring unrelated files", () => {
    const before = environmentFingerprint(sandbox());
    write("notes.md", "x");
    expect(environmentFingerprint(sandbox())).toBe(before);
    write("uv.lock", "v1");
    const withLock = environmentFingerprint(sandbox());
    expect(withLock).not.toBe(before);
    fs.mkdirSync(path.join(sandbox(), ".venv", "lib", "python3.12", "site-packages"), {
      recursive: true,
    });
    write(".venv/pyvenv.cfg", "version_info = 3.12.4");
    expect(environmentFingerprint(sandbox())).not.toBe(withLock);
  });

  it("detects environment-changing commands and lockfile changes", () => {
    expect(environmentMayHaveChanged({ command: "uv add scanpy" }, [])).toBe(true);
    expect(environmentMayHaveChanged({ command: "pip install numpy" }, [])).toBe(true);
    expect(environmentMayHaveChanged({ command: "Rscript -e 'install.packages(\"x\")'" }, [])).toBe(
      true,
    );
    expect(environmentMayHaveChanged({ command: "uv run python a.py" }, ["uv.lock"])).toBe(true);
    expect(environmentMayHaveChanged({ command: "uv run python a.py" }, ["fig.png"])).toBe(false);
    expect(environmentMayHaveChanged({ command: "ls" }, [])).toBe(false);
  });
});

describe("recorder: inferred inputs and environment stamping", () => {
  function recorder(capture: () => Promise<EnvironmentSnapshot | null>) {
    return new ProvenanceRecorder({
      projectId: PROJECT,
      sessionId: "sess-a",
      sandboxRoot: sandbox(),
      runId: "run_abc",
      getModel: () => "openrouter/anthropic/claude-opus-4",
      captureEnvironment: capture,
    });
  }

  it("records files a bash command names as inferred inputs, never the outputs", async () => {
    write("de_analysis.py", "print(1)");
    write("data/counts.csv", "a,b\n");
    const rec = recorder(async () => null);
    await rec.flush();
    rec.observe(startEvent("tc_b", "bash", { command: "uv run python de_analysis.py data/counts.csv > fig.png" }));
    write("fig.png", "PNG");
    rec.observe(endEvent("tc_b", "bash"));
    await rec.flush();

    const [row] = readSteps("sess-a", PROJECT);
    expect(row.inputs.map((i) => [i.path, i.change, i.confidence])).toEqual([
      ["data/counts.csv", "read", "inferred"],
      ["de_analysis.py", "read", "inferred"],
    ]);
    expect(row.inputs[0].sha256).toHaveLength(64);
    expect(row.outputs.map((o) => o.path)).toEqual(["fig.png"]);
    expect(row.environmentId).toBeUndefined();
  });

  it("does not report a file the command overwrote as an input", async () => {
    write("out.csv", "old");
    const rec = recorder(async () => null);
    await rec.flush();
    rec.observe(startEvent("tc_b", "bash", { command: "python gen.py > out.csv" }));
    write("out.csv", "new content");
    rec.observe(endEvent("tc_b", "bash"));
    await rec.flush();
    const [row] = readSteps("sess-a", PROJECT);
    expect(row.inputs).toEqual([]);
    expect(row.outputs[0]).toMatchObject({ path: "out.csv", change: "modified" });
  });

  it("stamps steps with the environment in effect and re-captures after an install", async () => {
    let calls = 0;
    const envs = [fakeEnv("before"), fakeEnv("after")];
    const rec = recorder(async () => envs[Math.min(calls++, 1)]);
    await rec.flush();

    rec.observe(startEvent("tc_1", "bash", { command: "uv run python a.py" }));
    rec.observe(endEvent("tc_1", "bash"));
    rec.observe(startEvent("tc_2", "bash", { command: "uv add scanpy" }));
    rec.observe(endEvent("tc_2", "bash"));
    rec.observe(startEvent("tc_3", "write", { path: "b.py" }));
    write("b.py", "x");
    rec.observe(endEvent("tc_3", "write"));
    await rec.flush();

    const rows = readSteps("sess-a", PROJECT);
    expect(rows.map((r) => r.environmentId)).toEqual([envs[0].id, envs[0].id, envs[1].id]);
    expect(calls).toBe(2);
    expect(readEnvironment(envs[1].id, PROJECT)?.python?.packages[0].name).toBe("after");
  });

  it("re-captures when uv run silently creates the venv and lockfile", async () => {
    let calls = 0;
    const envs = [fakeEnv("system"), fakeEnv("venv")];
    const rec = recorder(async () => envs[Math.min(calls++, 1)]);
    await rec.flush();

    // `uv run` writes uv.lock (hidden from the scan) and .venv (a dot-dir the
    // scan skips): nothing in the diff, no install verb in the command.
    rec.observe(startEvent("tc_1", "bash", { command: "uv run python a.py" }));
    write("uv.lock", "version = 1");
    write(".venv/pyvenv.cfg", "version_info = 3.12.4");
    write(".venv/lib/python3.12/site-packages/pandas-2.2.2.dist-info/METADATA", "");
    write("fig.png", "PNG");
    rec.observe(endEvent("tc_1", "bash"));
    rec.observe(startEvent("tc_2", "bash", { command: "ls" }));
    rec.observe(endEvent("tc_2", "bash"));
    rec.observe(startEvent("tc_3", "bash", { command: "ls" }));
    rec.observe(endEvent("tc_3", "bash"));
    await rec.flush();

    const rows = readSteps("sess-a", PROJECT);
    expect(rows.map((r) => r.environmentId)).toEqual([envs[0].id, envs[1].id, envs[1].id]);
    // No spurious re-capture for the unchanged steps afterwards.
    expect(calls).toBe(2);
  });

  it("keeps the last good environment when a re-capture fails", async () => {
    let calls = 0;
    const first = fakeEnv("only");
    const rec = recorder(async () => (calls++ === 0 ? first : null));
    await rec.flush();
    rec.observe(startEvent("tc_1", "bash", { command: "pip install x" }));
    rec.observe(endEvent("tc_1", "bash"));
    rec.observe(startEvent("tc_2", "bash", { command: "ls" }));
    rec.observe(endEvent("tc_2", "bash"));
    await rec.flush();
    const rows = readSteps("sess-a", PROJECT);
    expect(rows.map((r) => r.environmentId)).toEqual([first.id, first.id]);
  });
});

describe("harvest: inferred inputs for a child's opaque call", () => {
  it("attaches files the command names that predate the call", () => {
    // The call ran a minute ago; the script predates it, the output postdates it.
    const T0 = Date.now() - 60_000;
    const script = write("de.py", "print(1)");
    const past = new Date(T0 - 60_000);
    fs.utimesSync(script, past, past);
    const lines = [
      JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "python de.py > fig.png" } }],
        },
      }),
      JSON.stringify({
        timestamp: new Date(T0 + 1000).toISOString(),
        message: { role: "toolResult", toolCallId: "c1", isError: false },
      }),
    ];
    write("fig.png", "PNG"); // mtime now, i.e. after the call started
    const { steps } = provenanceStepsFromSessionFile(lines.join("\n"), "analyst", {
      parentSessionId: "parent",
      sandboxRoot: sandbox(),
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].degraded).toBe("no-scan-baseline");
    expect(steps[0].inputs.map((i) => [i.path, i.confidence, i.identityAt])).toEqual([
      ["de.py", "inferred", "harvest"],
    ]);
  });
});

describe("user steps via the sandbox API", () => {
  it("records an upload as a created output in the user pseudo-session", async () => {
    const boundary = "----kadyprov";
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="counts.csv"\r\n` +
        `Content-Type: text/csv\r\n\r\n` +
        `a,b\n1,2\n\r\n` +
        `--${boundary}--\r\n`,
    );
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/upload",
      headers: {
        "x-project-id": PROJECT,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().uploaded).toEqual(["user_data/counts.csv"]);

    const [row] = readSteps(USER_SESSION_ID, PROJECT);
    expect(row).toMatchObject({ role: "user", toolName: "upload" });
    expect(row.outputs).toHaveLength(1);
    expect(row.outputs[0]).toMatchObject({
      path: "user_data/counts.csv",
      change: "created",
      confidence: "observed",
    });
    expect(row.outputs[0].sha256).toHaveLength(64);
  });

  it("records an editor save as modified with the overwritten version as input", async () => {
    write("notes.md", "v1");
    const before = fs.readFileSync(path.join(sandbox(), "notes.md"));
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/file?path=notes.md",
      headers: { "x-project-id": PROJECT, "content-type": "text/plain" },
      payload: "v2 longer",
    });
    expect(res.statusCode).toBe(200);
    const rows = readSteps(USER_SESSION_ID, PROJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("save");
    expect(rows[0].outputs[0]).toMatchObject({ path: "notes.md", change: "modified" });
    expect(rows[0].inputs[0]).toMatchObject({ path: "notes.md", change: "read", size: before.length });
    expect(rows[0].inputs[0].sha256).not.toBe(rows[0].outputs[0].sha256);

    // The artifact is now explained rather than mysteriously stale.
    const prov = artifactProvenance(PROJECT, "notes.md");
    expect(prov.staleness).toBe("current");
    expect(prov.producedBy[0].role).toBe("user");
  });

  it("records a save of a new file as created", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/file?path=new.txt",
      headers: { "x-project-id": PROJECT, "content-type": "text/plain" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(200);
    const [row] = readSteps(USER_SESSION_ID, PROJECT);
    expect(row.outputs[0]).toMatchObject({ path: "new.txt", change: "created" });
    expect(row.inputs).toEqual([]);
  });

  it("records a move as input -> created plus deleted, so lineage passes through", async () => {
    write("raw/a.csv", "1");
    write("raw/sub/b.csv", "22");
    fs.mkdirSync(path.join(sandbox(), "data"), { recursive: true });
    const res = await inject("POST", "/sandbox/move", { src: "raw", dest: "data/raw" });
    expect(res.statusCode).toBe(200);
    const [row] = readSteps(USER_SESSION_ID, PROJECT);
    expect(row.toolName).toBe("move");
    expect(row.args).toEqual({ src: "raw", dest: "data/raw" });
    expect(row.inputs.map((i) => i.path).sort()).toEqual(["raw/a.csv", "raw/sub/b.csv"]);
    expect(row.outputs.filter((o) => o.change === "created").map((o) => o.path).sort()).toEqual([
      "data/raw/a.csv",
      "data/raw/sub/b.csv",
    ]);
    expect(row.outputs.filter((o) => o.change === "deleted").map((o) => o.path).sort()).toEqual([
      "raw/a.csv",
      "raw/sub/b.csv",
    ]);
  });

  it("records file and directory deletions with the removed identities", async () => {
    write("scratch.txt", "temp");
    write("tmpdir/x.txt", "x");
    write("tmpdir/y.txt", "yy");
    await inject("DELETE", "/sandbox/file?path=scratch.txt");
    await inject("DELETE", "/sandbox/directory?path=tmpdir");
    const rows = readSteps(USER_SESSION_ID, PROJECT);
    expect(rows).toHaveLength(2);
    expect(rows[0].outputs[0]).toMatchObject({ path: "scratch.txt", change: "deleted", size: 4 });
    expect(rows[0].outputs[0].sha256).toHaveLength(64);
    expect(rows[1].outputs.map((o) => o.path).sort()).toEqual(["tmpdir/x.txt", "tmpdir/y.txt"]);
  });
});

describe("Modal compute steps", () => {
  const job = (over: Partial<ModalJob> = {}): ModalJob => ({
    version: 1,
    id: "job_123",
    projectId: PROJECT,
    state: "succeeded",
    request: {
      command: "python train.py",
      instance: "gpu-a100",
      gpuCount: 1,
      timeoutSec: 600,
      filesIn: ["train.py", "data/"],
      filesOut: ["model.pt"],
      image: { pip: ["torch"] },
    },
    owner: { sessionId: "sess-a", runId: "run_1", submittedBy: "lead" },
    createdAt: 10,
    updatedAt: 60,
    queuedAt: 10,
    preparingAt: 20,
    runningAt: 30,
    finishedAt: 60,
    cancelRequested: false,
    reservationUsd: 1,
    effectiveInstance: "gpu-a100",
    effectiveGpu: "A100",
    sandboxId: "sb-1",
    sandboxName: "kady",
    sandboxTags: {},
    exitCode: 0,
    inputFiles: [{ path: "train.py", size: 5, sha256: "1".repeat(64) }],
    outputFiles: [{ path: "model.pt", size: 9, sha256: "2".repeat(64) }],
    missingOutputs: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutBaseCursor: 0,
    stderrBaseCursor: 0,
    eventSeq: 0,
    accounting: { reconciled: false },
    ...over,
  });

  it("maps a job to a compute step using the transfer layer's hashes", () => {
    const s = modalJobStep(job(), sandbox());
    expect(s).toMatchObject({
      id: "modal:job_123",
      sessionId: "sess-a",
      runId: "run_1",
      toolName: "modal_job",
      role: "compute",
      startedAt: 30,
      timestamp: 60,
    });
    expect(s.isError).toBeUndefined();
    expect(s.inputs[0]).toMatchObject({
      path: "train.py",
      sha256: "1".repeat(64),
      change: "read",
      confidence: "observed",
    });
    expect(s.outputs[0]).toMatchObject({
      path: "model.pt",
      sha256: "2".repeat(64),
      change: "wrote",
      confidence: "observed",
    });
    // Write-time identity, unlike a harvested subagent ref.
    expect(s.outputs[0].identityAt).toBeUndefined();
    expect(s.compute).toMatchObject({
      provider: "modal",
      jobId: "job_123",
      instance: "gpu-a100",
      gpu: "A100",
      exitCode: 0,
      submittedBy: "lead",
    });
    expect(s.args).toMatchObject({ command: "python train.py", instance: "gpu-a100" });
  });

  it("marks a failed job as an error and keeps its missing outputs visible", () => {
    const s = modalJobStep(
      job({ state: "failed", exitCode: 1, outputFiles: [], missingOutputs: ["model.pt"] }),
      sandbox(),
    );
    expect(s.isError).toBe(true);
    expect(s.outputs).toEqual([]);
    expect(s.compute?.missingOutputs).toEqual(["model.pt"]);
  });
});

describe("lineage walk", () => {
  const H = (c: string) => c.repeat(64);

  it("walks figure <- script + data <- upload, version-aware", () => {
    write("user_data/raw.csv", "raw");
    write("de.py", "code");
    write("counts.csv", "counts");
    write("fig.png", "PNG");
    const steps: ProvenanceStep[] = [
      step({
        id: "u1",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "upload",
        timestamp: 100,
        outputs: [ref({ path: "user_data/raw.csv", sha256: H("a") })],
      }),
      step({
        id: "w1",
        toolName: "write",
        timestamp: 200,
        outputs: [ref({ path: "de.py", sha256: H("b") })],
      }),
      step({
        id: "b1",
        toolName: "bash",
        startedAt: 290,
        timestamp: 300,
        inputs: [ref({ path: "user_data/raw.csv", sha256: H("a"), change: "read", confidence: "inferred" })],
        outputs: [ref({ path: "counts.csv", sha256: H("c") })],
      }),
      // counts.csv regenerated AFTER the figure was made: must not be picked.
      step({
        id: "b3",
        toolName: "bash",
        timestamp: 500,
        outputs: [ref({ path: "counts.csv", sha256: H("e"), change: "modified" })],
      }),
      step({
        id: "b2",
        toolName: "bash",
        startedAt: 390,
        timestamp: 400,
        inputs: [
          ref({ path: "de.py", sha256: H("b"), change: "read", confidence: "inferred" }),
          ref({ path: "counts.csv", sha256: H("c"), change: "read", confidence: "inferred" }),
        ],
        outputs: [ref({ path: "fig.png", sha256: H("d") })],
      }),
    ].sort((a, b) => a.timestamp - b.timestamp);

    const lineage = walkLineage(sandbox(), "fig.png", steps);
    const byPath = Object.fromEntries(lineage.nodes.map((n) => [n.path, n]));
    expect(byPath["fig.png"]).toMatchObject({ depth: 0, stepId: "b2" });
    expect(byPath["de.py"]).toMatchObject({ depth: 1, stepId: "w1" });
    // The version the figure consumed, not the later regeneration.
    expect(byPath["counts.csv"]).toMatchObject({ depth: 1, stepId: "b1" });
    expect(byPath["user_data/raw.csv"]).toMatchObject({ depth: 2, stepId: "u1", root: "upload" });
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        { from: "de.py", to: "fig.png", stepId: "b2", confidence: "inferred" },
        { from: "counts.csv", to: "fig.png", stepId: "b2", confidence: "inferred" },
        { from: "user_data/raw.csv", to: "counts.csv", stepId: "b1", confidence: "inferred" },
      ]),
    );
    expect(Object.keys(lineage.steps).sort()).toEqual(["b1", "b2", "u1", "w1"]);
    expect(lineage.truncated).toBe(false);
    // Disk bytes differ from every recorded fake hash, so each upstream input
    // reports as changed since use; the artifact itself uses `staleness`.
    expect(byPath["counts.csv"].changedSinceUse).toBe(true);
    expect(byPath["fig.png"].changedSinceUse).toBeUndefined();
  });

  it("reports changedSinceUse=false when the input still matches what was consumed", () => {
    const abs = write("counts.csv", "counts");
    const realHash = sha256File(abs)!;
    write("fig.png", "PNG");
    const steps = [
      step({ id: "b1", timestamp: 100, outputs: [ref({ path: "counts.csv", sha256: realHash })] }),
      step({
        id: "b2",
        timestamp: 200,
        inputs: [ref({ path: "counts.csv", sha256: realHash, change: "read" })],
        outputs: [ref({ path: "fig.png", sha256: H("d") })],
      }),
    ];
    const lineage = walkLineage(sandbox(), "fig.png", steps);
    expect(lineage.nodes.find((n) => n.path === "counts.csv")?.changedSinceUse).toBe(false);
  });

  it("marks an input nothing recorded as an unrecorded root, and a user-made file as user", () => {
    write("fig.png", "PNG");
    const steps = [
      step({
        id: "s1",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "save",
        timestamp: 50,
        outputs: [ref({ path: "params.json", sha256: H("p") })],
      }),
      step({
        id: "b2",
        timestamp: 200,
        inputs: [
          ref({ path: "mystery.csv", change: "read" }),
          ref({ path: "params.json", sha256: H("p"), change: "read" }),
        ],
        outputs: [ref({ path: "fig.png" })],
      }),
    ];
    const lineage = walkLineage(sandbox(), "fig.png", steps);
    const byPath = Object.fromEntries(lineage.nodes.map((n) => [n.path, n]));
    expect(byPath["mystery.csv"]).toMatchObject({ root: "unrecorded", current: null });
    expect(byPath["mystery.csv"].stepId).toBeUndefined();
    expect(byPath["mystery.csv"].changedSinceUse).toBeNull();
    expect(byPath["params.json"]).toMatchObject({ root: "user", stepId: "s1" });
  });

  it("does not draw a self-edge for an in-place editor save", () => {
    write("notes.md", "v2");
    write("fig.png", "PNG");
    const steps = [
      step({
        id: "s1",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "save",
        timestamp: 10,
        outputs: [ref({ path: "notes.md", sha256: H("1") })],
      }),
      step({
        id: "s2",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "save",
        timestamp: 20,
        inputs: [ref({ path: "notes.md", sha256: H("1"), change: "read" })],
        outputs: [ref({ path: "notes.md", sha256: H("2"), change: "modified" })],
      }),
      step({
        id: "b1",
        timestamp: 30,
        inputs: [ref({ path: "notes.md", sha256: H("2"), change: "read" })],
        outputs: [ref({ path: "fig.png" })],
      }),
    ];
    const lineage = walkLineage(sandbox(), "fig.png", steps);
    expect(lineage.edges).toEqual([
      { from: "notes.md", to: "fig.png", stepId: "b1", confidence: "observed" },
    ]);
    const notes = lineage.nodes.find((n) => n.path === "notes.md");
    // Latest version's producer, with no root claimed: the edit history lives
    // in "Produced by", and "created by you" would misdescribe a modification.
    expect(notes).toMatchObject({ stepId: "s2" });
    expect(notes?.root).toBeUndefined();

    // Asking about notes.md itself yields no lineage edges at all.
    expect(walkLineage(sandbox(), "notes.md", steps).edges).toEqual([]);
  });

  it("passes through a user move to the original producer", () => {
    write("data/raw.csv", "raw");
    write("fig.png", "PNG");
    const steps = [
      step({
        id: "u1",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "upload",
        timestamp: 10,
        outputs: [ref({ path: "user_data/raw.csv", sha256: H("a") })],
      }),
      step({
        id: "m1",
        sessionId: USER_SESSION_ID,
        role: "user",
        toolName: "move",
        timestamp: 20,
        inputs: [ref({ path: "user_data/raw.csv", sha256: H("a"), change: "read" })],
        outputs: [
          ref({ path: "data/raw.csv", sha256: H("a") }),
          ref({ path: "user_data/raw.csv", change: "deleted" }),
        ],
      }),
      step({
        id: "b1",
        timestamp: 30,
        inputs: [ref({ path: "data/raw.csv", sha256: H("a"), change: "read" })],
        outputs: [ref({ path: "fig.png" })],
      }),
    ];
    const lineage = walkLineage(sandbox(), "fig.png", steps);
    const byPath = Object.fromEntries(lineage.nodes.map((n) => [n.path, n]));
    expect(byPath["data/raw.csv"]).toMatchObject({ stepId: "m1" });
    expect(byPath["user_data/raw.csv"]).toMatchObject({ stepId: "u1", root: "upload", depth: 2 });
  });

  it("stops at the depth budget and says so", () => {
    const steps: ProvenanceStep[] = [];
    for (let i = 0; i < 20; i++) {
      steps.push(
        step({
          id: `s${i}`,
          timestamp: 100 + i,
          inputs: [ref({ path: `f${i}.csv`, change: "read" })],
          outputs: [ref({ path: `f${i + 1}.csv` })],
        }),
      );
    }
    const lineage = walkLineage(sandbox(), "f20.csv", steps);
    expect(lineage.truncated).toBe(true);
    expect(lineage.nodes.some((n) => n.root === "budget")).toBe(true);
  });

  it("is returned by the API along with referenced environments", async () => {
    write("fig.png", "PNG");
    write("counts.csv", "c");
    const env = fakeEnv("scanpy");
    storeEnvironment(env, PROJECT);
    appendStep(
      step({
        id: "b1",
        timestamp: 100,
        environmentId: env.id,
        inputs: [ref({ path: "counts.csv", change: "read", confidence: "inferred" })],
        outputs: [ref({ path: "fig.png" })],
      }),
      PROJECT,
    );
    const res = await inject("GET", "/sandbox/provenance?path=fig.png");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lineage.nodes.map((n: { path: string }) => n.path)).toEqual(["fig.png", "counts.csv"]);
    expect(body.lineage.edges).toHaveLength(1);
    expect(body.environments[env.id].python.packages[0].name).toBe("scanpy");
  });
});
