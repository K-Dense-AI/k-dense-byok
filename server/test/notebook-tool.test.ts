import { describe, it, expect } from "vitest";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";

const run = (tool: ReturnType<typeof makeNotebookTool>, id: string, params: unknown) =>
  tool.execute(id, params as never, undefined as never);

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

  it("rejects an empty title", async () => {
    const tool = makeNotebookTool("default", () => "sess-tool-b");
    await expect(run(tool, "tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
  });

  it("declares the notebook tool name", () => {
    expect(makeNotebookTool("default", () => "s").name).toBe("notebook");
  });
});
