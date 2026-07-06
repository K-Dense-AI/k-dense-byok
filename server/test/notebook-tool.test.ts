import fs from "node:fs";
import { beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";

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

  it("rejects an empty title", async () => {
    const tool = makeNotebookTool("default", () => "sess-tool-b");
    await expect(run(tool, "tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
  });

  it("declares the notebook tool name", () => {
    expect(makeNotebookTool("default", () => "s").name).toBe("notebook");
  });
});
