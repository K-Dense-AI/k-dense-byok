import { describe, expect, it } from "vitest";
import { moveQueuedMessage, updateQueuedMessageText } from "./message-queue";

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
