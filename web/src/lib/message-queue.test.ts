import { describe, expect, it } from "vitest";
import { moveQueuedMessage, splitQueuedText, updateQueuedMessageText } from "./message-queue";
import { buildComposerContext, EMPTY_DELEGATION } from "./composer-context";

const queue = [
  { id: "1", text: "first", rawText: "first" },
  { id: "2", text: "second", rawText: "second" },
  { id: "3", text: "third", rawText: "third" },
];

describe("moveQueuedMessage", () => {
  it("swaps with the previous neighbour on up", () => {
    expect(moveQueuedMessage(queue, "2", "up").map((m) => m.id)).toEqual(["2", "1", "3"]);
  });

  it("swaps with the next neighbour on down", () => {
    expect(moveQueuedMessage(queue, "2", "down").map((m) => m.id)).toEqual(["1", "3", "2"]);
  });

  it("is a no-op at the edges and for unknown ids (same identity)", () => {
    expect(moveQueuedMessage(queue, "1", "up")).toBe(queue);
    expect(moveQueuedMessage(queue, "3", "down")).toBe(queue);
    expect(moveQueuedMessage(queue, "nope", "up")).toBe(queue);
  });

  it("does not mutate the input", () => {
    const copy = [...queue];
    moveQueuedMessage(queue, "1", "down");
    expect(queue).toEqual(copy);
  });
});

describe("updateQueuedMessageText", () => {
  it("replaces text and derives the one-line preview from the first line", () => {
    const next = updateQueuedMessageText(queue, "2", "  new line one\nline two  ");
    expect(next[1]).toEqual({ id: "2", text: "new line one\nline two", rawText: "new line one" });
    expect(next[0]).toBe(queue[0]);
    expect(next[2]).toBe(queue[2]);
  });

  it("ignores empty edits, unknown ids and unchanged text (same identity)", () => {
    expect(updateQueuedMessageText(queue, "2", "   ")).toBe(queue);
    expect(updateQueuedMessageText(queue, "nope", "x")).toBe(queue);
    expect(updateQueuedMessageText(queue, "2", "second")).toBe(queue);
  });
});

describe("splitQueuedText", () => {
  const appended = "\nuser_data/a.csv\n\nMake sure to use the skills: 'scanpy'";
  const block = buildComposerContext({ delegation: { ...EMPTY_DELEGATION, verify: true }, research: [] });

  it("edits only what the user typed and keeps the appended context verbatim", () => {
    const text = "Run QC\nthen plot" + appended + block;
    const { editable, suffix } = splitQueuedText(text, appended);
    expect(editable).toBe("Run QC\nthen plot");
    expect(suffix).toBe(appended + block);
    expect("Run QC again" + suffix).toBe(text.replace("Run QC\nthen plot", "Run QC again"));
  });

  it("handles messages without the + block or with nothing appended", () => {
    expect(splitQueuedText("Just text", "")).toEqual({ editable: "Just text", suffix: "" });
    expect(splitQueuedText("Hi" + block, "")).toEqual({ editable: "Hi", suffix: block });
  });

  it("leaves unmatched appended text editable instead of guessing", () => {
    expect(splitQueuedText("Hi\nother.csv", "\nuser_data/a.csv")).toEqual({ editable: "Hi\nother.csv", suffix: "" });
  });

  it("keeps a files-only message's attachments when the typed part is empty", () => {
    const sent = appended.trimStart() + block;
    expect(splitQueuedText(sent, appended)).toEqual({ editable: "", suffix: sent });
  });
});
