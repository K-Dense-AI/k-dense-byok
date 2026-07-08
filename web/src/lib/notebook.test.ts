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

  it("parses relatesTo, stance, and supersedes", () => {
    const e = parseNotebookFrame(
      frame({
        type: "observation",
        title: "Peak at 42",
        relatesTo: "tc_h1",
        stance: "supports",
        supersedes: "tc_old",
      }),
    );
    expect(e).toMatchObject({ relatesTo: "tc_h1", stance: "supports", supersedes: "tc_old" });
  });

  it("drops an invalid stance but keeps the rest of the entry", () => {
    const e = parseNotebookFrame(
      frame({ type: "observation", title: "x", relatesTo: "tc_h1", stance: "maybe" }),
    );
    expect(e).not.toBeNull();
    expect(e!.stance).toBeUndefined();
    expect(e!.relatesTo).toBe("tc_h1");
  });

  it("drops empty-string link fields", () => {
    const e = parseNotebookFrame(
      frame({ type: "observation", title: "x", relatesTo: "", supersedes: "   " }),
    );
    expect(e!.relatesTo).toBeUndefined();
    expect(e!.supersedes).toBeUndefined();
  });

  it("stamps the provisional runId only when one is given", () => {
    const stamped = parseNotebookFrame(frame({ type: "note", title: "x" }), "run_1");
    expect(stamped!.runId).toBe("run_1");
    const unstamped = parseNotebookFrame(frame({ type: "note", title: "x" }));
    expect(unstamped).not.toBeNull();
    expect("runId" in unstamped!).toBe(false);
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

  it("preserves the new link/run fields, with the authoritative (b) side winning", () => {
    const live = [mk("tc_1", { relatesTo: "tc_h", stance: "supports", runId: "run_live" })];
    const fetched = [
      mk("tc_1", {
        relatesTo: "tc_h",
        stance: "refutes",
        supersedes: "tc_old",
        runId: "run_srv",
        sessionId: "s1",
      }),
    ];
    const merged = mergeNotebookEntries(live, fetched);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      relatesTo: "tc_h",
      stance: "refutes",
      supersedes: "tc_old",
      runId: "run_srv",
      sessionId: "s1",
    });
  });
});
