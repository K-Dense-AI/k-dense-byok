import { describe, it, expect } from "vitest";
import {
  applyOp,
  derive,
  EMPTY_DOC,
  type AnnotationsDoc,
  type NotebookAnnotation,
} from "./notebook-annotations";

const ann = (over: Partial<NotebookAnnotation> = {}): NotebookAnnotation => ({
  id: "a1",
  kind: "pin",
  entryId: "e1",
  createdAt: 1,
  ...over,
});

describe("applyOp", () => {
  it("adds an annotation without mutating the input doc", () => {
    const doc: AnnotationsDoc = { version: 1, annotations: [] };
    const next = applyOp(doc, { op: "add", annotation: ann() });
    expect(next.annotations).toHaveLength(1);
    expect(doc.annotations).toHaveLength(0); // input untouched
    expect(next).not.toBe(doc);
  });

  it("is idempotent on add by id", () => {
    const doc = applyOp(EMPTY_DOC, { op: "add", annotation: ann() });
    const again = applyOp(doc, { op: "add", annotation: ann({ body: "changed" }) });
    expect(again).toBe(doc); // same reference — no-op
    expect(again.annotations).toHaveLength(1);
  });

  it("removes an annotation by id, immutably", () => {
    const doc = applyOp(EMPTY_DOC, { op: "add", annotation: ann() });
    const next = applyOp(doc, { op: "remove", id: "a1" });
    expect(next.annotations).toHaveLength(0);
    expect(doc.annotations).toHaveLength(1);
  });

  it("treats remove of a missing id as a no-op on content", () => {
    const doc = applyOp(EMPTY_DOC, { op: "add", annotation: ann() });
    const next = applyOp(doc, { op: "remove", id: "nope" });
    expect(next.annotations).toEqual(doc.annotations);
  });
});

describe("derive", () => {
  it("derives empty collections from the empty doc", () => {
    const d = derive(EMPTY_DOC);
    expect(d.pinnedIds.size).toBe(0);
    expect(d.pinIdByEntry.size).toBe(0);
    expect(d.commentsByEntry.size).toBe(0);
    expect(d.notes).toEqual([]);
  });

  it("maps pins to pinnedIds and pinIdByEntry", () => {
    const d = derive({
      version: 1,
      annotations: [ann({ id: "p1", entryId: "e1" }), ann({ id: "p2", entryId: "e2" })],
    });
    expect([...d.pinnedIds].sort()).toEqual(["e1", "e2"]);
    expect(d.pinIdByEntry.get("e1")).toBe("p1");
    expect(d.pinIdByEntry.get("e2")).toBe("p2");
  });

  it("groups comments by entry, sorted by createdAt", () => {
    const d = derive({
      version: 1,
      annotations: [
        ann({ id: "c2", kind: "comment", entryId: "e1", body: "second", createdAt: 20 }),
        ann({ id: "c1", kind: "comment", entryId: "e1", body: "first", createdAt: 10 }),
        ann({ id: "c3", kind: "comment", entryId: "e2", body: "other", createdAt: 5 }),
      ],
    });
    expect(d.commentsByEntry.get("e1")?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(d.commentsByEntry.get("e2")?.map((c) => c.id)).toEqual(["c3"]);
  });

  it("collects notes sorted by createdAt", () => {
    const d = derive({
      version: 1,
      annotations: [
        ann({ id: "n2", kind: "note", entryId: undefined, body: "later", createdAt: 9 }),
        ann({ id: "n1", kind: "note", entryId: undefined, body: "sooner", createdAt: 3 }),
      ],
    });
    expect(d.notes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("ignores pins and comments that lack an entryId", () => {
    const d = derive({
      version: 1,
      annotations: [
        ann({ id: "p1", kind: "pin", entryId: undefined }),
        ann({ id: "c1", kind: "comment", entryId: undefined, body: "orphan" }),
      ],
    });
    expect(d.pinnedIds.size).toBe(0);
    expect(d.commentsByEntry.size).toBe(0);
    expect(d.notes).toEqual([]);
  });
});
