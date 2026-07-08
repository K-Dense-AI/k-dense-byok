import { describe, it, expect } from "vitest";
import { deriveThreads } from "./notebook-threads";
import type { NotebookEntry } from "./notebook";

const e = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id,
  type: "note",
  title: id,
  timestamp: 0,
  ...over,
});

describe("deriveThreads", () => {
  it("returns an empty map for no entries", () => {
    expect(deriveThreads([]).size).toBe(0);
  });

  it("marks a hypothesis with no incoming links as open", () => {
    const threads = deriveThreads([e("h1", { type: "hypothesis" })]);
    expect(threads.get("h1")?.status).toBe("open");
  });

  it("records incoming links with their stance (defaulting to neutral)", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 2, relatesTo: "h1", stance: "supports" }),
      e("o2", { type: "observation", timestamp: 3, relatesTo: "h1" }),
    ]);
    expect(threads.get("h1")?.incoming).toEqual([
      { id: "o1", stance: "supports" },
      { id: "o2", stance: "neutral" },
    ]);
  });

  it("sets status from the latest non-neutral entry targeting the hypothesis", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 2, relatesTo: "h1", stance: "supports" }),
      e("o2", { type: "observation", timestamp: 3, relatesTo: "h1", stance: "refutes" }),
    ]);
    expect(threads.get("h1")?.status).toBe("refuted");
  });

  it("ignores neutral entries when deciding status, even when they are latest", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 2, relatesTo: "h1", stance: "supports" }),
      e("o2", { type: "observation", timestamp: 99, relatesTo: "h1", stance: "neutral" }),
    ]);
    expect(threads.get("h1")?.status).toBe("supported");
  });

  it("breaks timestamp ties toward the later entry in the list (>=)", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 5, relatesTo: "h1", stance: "supports" }),
      e("o2", { type: "observation", timestamp: 5, relatesTo: "h1", stance: "refutes" }),
    ]);
    expect(threads.get("h1")?.status).toBe("refuted");
  });

  it("ignores dangling relatesTo / supersedes ids", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 2, relatesTo: "gone", stance: "refutes" }),
      e("o2", { type: "observation", timestamp: 3, supersedes: "also-gone" }),
    ]);
    expect(threads.get("h1")?.status).toBe("open");
    expect(threads.get("gone")).toBeUndefined();
    expect(threads.get("also-gone")).toBeUndefined();
  });

  it("only assigns a status to hypothesis entries", () => {
    const threads = deriveThreads([
      e("m1", { type: "method", timestamp: 1 }),
      e("o1", { type: "observation", timestamp: 2, relatesTo: "m1", stance: "supports" }),
    ]);
    expect(threads.get("m1")?.status).toBeUndefined();
    expect(threads.get("m1")?.incoming).toHaveLength(1);
  });

  it("sets supersededBy on the superseded target", () => {
    const threads = deriveThreads([
      e("h1", { type: "hypothesis", timestamp: 1 }),
      e("h2", { type: "hypothesis", timestamp: 2, supersedes: "h1" }),
    ]);
    expect(threads.get("h1")?.supersededBy).toBe("h2");
    expect(threads.get("h2")?.supersededBy).toBeUndefined();
  });
});
