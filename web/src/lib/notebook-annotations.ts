/**
 * Client model + pure doc operations for notebook annotations (pins, comments,
 * standalone user notes). The doc mirrors the server sidecar envelope; ops are
 * id-based so an optimistic apply and a 412 rebase produce the same result.
 */
export type NotebookAnnotationKind = "pin" | "comment" | "note";

export interface NotebookAnnotation {
  id: string;
  kind: NotebookAnnotationKind;
  /** Target agent-entry id; required for pin/comment. */
  entryId?: string;
  title?: string;
  body?: string;
  createdAt: number;
}

export interface AnnotationsDoc {
  version: 1;
  annotations: NotebookAnnotation[];
}

export const EMPTY_DOC: AnnotationsDoc = { version: 1, annotations: [] };

export type AnnotationOp =
  | { op: "add"; annotation: NotebookAnnotation }
  | { op: "remove"; id: string };

/** Add is id-idempotent; remove of a missing id is a no-op. */
export function applyOp(doc: AnnotationsDoc, op: AnnotationOp): AnnotationsDoc {
  if (op.op === "add") {
    if (doc.annotations.some((a) => a.id === op.annotation.id)) return doc;
    return { version: 1, annotations: [...doc.annotations, op.annotation] };
  }
  return { version: 1, annotations: doc.annotations.filter((a) => a.id !== op.id) };
}

export interface DerivedAnnotations {
  pinnedIds: Set<string>;
  /** Pin annotation id per pinned entry (needed to un-pin). */
  pinIdByEntry: Map<string, string>;
  commentsByEntry: Map<string, NotebookAnnotation[]>;
  notes: NotebookAnnotation[];
}

export function derive(doc: AnnotationsDoc): DerivedAnnotations {
  const pinnedIds = new Set<string>();
  const pinIdByEntry = new Map<string, string>();
  const commentsByEntry = new Map<string, NotebookAnnotation[]>();
  const notes: NotebookAnnotation[] = [];
  for (const a of doc.annotations) {
    if (a.kind === "pin" && a.entryId) {
      pinnedIds.add(a.entryId);
      pinIdByEntry.set(a.entryId, a.id);
    } else if (a.kind === "comment" && a.entryId) {
      const list = commentsByEntry.get(a.entryId);
      if (list) list.push(a);
      else commentsByEntry.set(a.entryId, [a]);
    } else if (a.kind === "note") {
      notes.push(a);
    }
  }
  for (const list of commentsByEntry.values()) list.sort((x, y) => x.createdAt - y.createdAt);
  notes.sort((x, y) => x.createdAt - y.createdAt);
  return { pinnedIds, pinIdByEntry, commentsByEntry, notes };
}
