import fs from "node:fs";
import { beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";
import { setSessionRunId } from "../src/agent/run-ids.ts";

const run = (tool: ReturnType<typeof makeNotebookTool>, id: string, params: unknown) =>
  tool.execute(id, params as never, undefined as never);

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

describe("notebook tool", () => {
  it("persists a stamped entry and returns a non-blocking ack", async () => {
    const s = "sess-tool-a";
    const tool = makeNotebookTool("default", () => s);
    const res = await run(tool, "tc_abc", {
      type: "hypothesis",
      title: "Clusters map to six cell types",
      body: "Silhouette suggests k=6.",
      confidence: "medium",
      artifacts: ["figures/fig08_silhouette.png"],
    });
    // Ack mentions the id; run is not blocked.
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toMatch(/tc_abc/);

    const entries = readNotebookEntries(s);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tc_abc",
      type: "hypothesis",
      role: "agent",
      confidence: "medium",
    });
    expect(typeof entries[0].timestamp).toBe("number");
  });

  it("normalizes an absolute sandbox path in artifacts to sandbox-relative", async () => {
    const s = "sess-tool-artifacts";
    const projectId = "default";
    const tool = makeNotebookTool(projectId, () => s);
    const sandbox = resolvePaths(projectId).sandbox;
    await run(tool, "tc_art", {
      type: "method",
      title: "Ran PCA",
      artifacts: [`${sandbox}/figures/fig01.png`, "figures/already-relative.png"],
    });

    const entries = readNotebookEntries(s, projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0].artifacts).toEqual([
      "figures/fig01.png",
      "figures/already-relative.png",
    ]);
  });

  it("persists relatesTo/stance/supersedes on the stored row", async () => {
    const s = "sess-tool-links";
    const tool = makeNotebookTool("default", () => s);
    await run(tool, "tc_2", {
      type: "observation",
      title: "ARI 0.99 supports the split",
      relatesTo: "tc_1",
      stance: "supports",
      supersedes: "tc_0",
    });
    const entries = readNotebookEntries(s);
    expect(entries[0]).toMatchObject({
      relatesTo: "tc_1",
      stance: "supports",
      supersedes: "tc_0",
    });
  });

  it("stamps runId when a run is live and omits it otherwise", async () => {
    const s = "sess-tool-runid";
    const tool = makeNotebookTool("default", () => s);
    // No run set: the stored row must carry no runId key at all.
    await run(tool, "tc_a", { type: "note", title: "before run" });
    // Run live: the row is stamped with the in-flight run id.
    setSessionRunId(s, "run_x");
    await run(tool, "tc_b", { type: "note", title: "during run" });
    // Cleared: back to no runId key.
    setSessionRunId(s, null);
    await run(tool, "tc_c", { type: "note", title: "after run" });

    const entries = readNotebookEntries(s);
    expect("runId" in entries[0]).toBe(false);
    expect(entries[1].runId).toBe("run_x");
    expect("runId" in entries[2]).toBe(false);
  });

  it("overwrites a model-injected id/role/runId with server stamps", async () => {
    const s = "sess-tool-inject";
    setSessionRunId(s, "run_server");
    const tool = makeNotebookTool("default", () => s);
    await run(tool, "tc_real", {
      type: "note",
      title: "hi",
      id: "evil_id",
      role: "evil_role",
      runId: "run_injected",
    });
    setSessionRunId(s, null);
    const entries = readNotebookEntries(s);
    expect(entries[0].id).toBe("tc_real");
    expect(entries[0].role).toBe("agent");
    expect(entries[0].runId).toBe("run_server");
  });

  it("acks with the entry id in the (id: ...) form", async () => {
    const tool = makeNotebookTool("default", () => "sess-tool-ack");
    const res = await run(tool, "tc_ack", { type: "note", title: "hi" });
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("(id: tc_ack)");
    expect(text).toMatch(/relatesTo\/supersedes/);
  });

  it("rejects an empty title", async () => {
    const tool = makeNotebookTool("default", () => "sess-tool-b");
    await expect(run(tool, "tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
  });

  it("declares the notebook tool name", () => {
    expect(makeNotebookTool("default", () => "s").name).toBe("notebook");
  });
});
