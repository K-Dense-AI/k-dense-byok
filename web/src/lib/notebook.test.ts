import { describe, it, expect } from "vitest";
import { parseNotebookFrame, mergeNotebookEntries, type NotebookEntry } from "./notebook";
import type { AgentFrame } from "./use-agent";

const frame = (args: unknown, over: Partial<AgentFrame> = {}): AgentFrame => ({
  type: "tool_start", toolName: "notebook", toolCallId: "tc_1", args, ...over,
} as AgentFrame);

describe("parseNotebookFrame", () => {
  it("parses a notebook tool_start frame into a provisional entry", () => {
    const e = parseNotebookFrame(frame({ type: "hypothesis", title: "Six types", confidence: "high" }));
    expect(e).toMatchObject({ id: "tc_1", type: "hypothesis", title: "Six types", confidence: "high" });
    expect(typeof e!.timestamp).toBe("number");
  });

  it("ignores non-notebook tool_start frames", () => {
    expect(parseNotebookFrame(frame({ type: "hypothesis", title: "x" }, { toolName: "bash" }))).toBeNull();
  });

  it("ignores non-tool_start frames", () => {
    expect(parseNotebookFrame({ type: "text_delta", delta: "hi" } as AgentFrame)).toBeNull();
  });

  it("returns null for an unknown entry type", () => {
    expect(parseNotebookFrame(frame({ type: "bogus", title: "x" }))).toBeNull();
  });

  it("returns null when title is missing", () => {
    expect(parseNotebookFrame(frame({ type: "note" }))).toBeNull();
  });
});

describe("mergeNotebookEntries", () => {
  const mk = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry =>
    ({ id, type: "note", title: id, timestamp: 0, ...over });

  it("dedupes by id, letting the authoritative (b) entry win", () => {
    const live = [mk("tc_1", { title: "provisional", timestamp: 5 })];
    const fetched = [mk("tc_1", { title: "authoritative", timestamp: 100, role: "agent" })];
    const merged = mergeNotebookEntries(live, fetched);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("authoritative");
  });

  it("sorts the union by timestamp", () => {
    const merged = mergeNotebookEntries([mk("a", { timestamp: 3 })], [mk("b", { timestamp: 1 })]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
