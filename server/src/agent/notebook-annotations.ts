/**
 * User annotations on a session's lab notebook: pins and comments targeting
 * agent entries, plus standalone user-authored notes. Stored as a JSON sidecar
 * next to the notebook JSONL (notebookDir/<sessionId>.annotations.json), so
 * the agent's rows stay immutable and the user's layer lives beside them.
 * Same envelope + optimistic-concurrency conventions as the sandbox file
 * annotations (server/src/api/sandbox.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { activePaths, resolvePaths } from "../projects.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { isValidSessionId } from "./notebook-store.ts";

export type NotebookAnnotationKind = "pin" | "comment" | "note";

export interface NotebookAnnotation {
  id: string;
  kind: NotebookAnnotationKind;
  /** Target agent-entry id; required for pin/comment. */
  entryId?: string;
  title?: string;
  /** Required non-empty for comment and note. */
  body?: string;
  /** Epoch ms. */
  createdAt: number;
}

export interface NotebookAnnotationsDoc {
  version: 1;
  annotations: NotebookAnnotation[];
}

export function notebookAnnotationsPath(sessionId: string, projectId?: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new SandboxError(400, `Invalid session id: ${sessionId}`);
  }
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.notebookDir, `${sessionId}.annotations.json`);
}

export function normalizeNotebookAnnotations(data: unknown): NotebookAnnotationsDoc {
  if (!data || typeof data !== "object") {
    throw new SandboxError(400, "Annotations body must be a JSON object");
  }
  const anns = (data as { annotations?: unknown }).annotations ?? [];
  if (!Array.isArray(anns)) throw new SandboxError(400, "'annotations' must be a list");
  anns.forEach((ann, i) => {
    if (!ann || typeof ann !== "object") {
      throw new SandboxError(400, `annotations[${i}] must be an object`);
    }
    const a = ann as Record<string, unknown>;
    if (!a.id || typeof a.id !== "string") {
      throw new SandboxError(400, `annotations[${i}].id is required`);
    }
    if (a.kind !== "pin" && a.kind !== "comment" && a.kind !== "note") {
      throw new SandboxError(400, `annotations[${i}].kind invalid`);
    }
    if ((a.kind === "pin" || a.kind === "comment") && (!a.entryId || typeof a.entryId !== "string")) {
      throw new SandboxError(400, `annotations[${i}].entryId is required for ${a.kind}`);
    }
    if (
      (a.kind === "comment" || a.kind === "note") &&
      (typeof a.body !== "string" || !a.body.trim())
    ) {
      throw new SandboxError(400, `annotations[${i}].body is required for ${a.kind}`);
    }
    if (typeof a.createdAt !== "number" || !Number.isFinite(a.createdAt) || a.createdAt <= 0) {
      throw new SandboxError(400, `annotations[${i}].createdAt must be epoch ms`);
    }
  });
  return { version: 1, annotations: anns as NotebookAnnotation[] };
}

export function readNotebookAnnotations(
  sessionId: string,
  projectId?: string,
): { doc: NotebookAnnotationsDoc; mtime: Date | null } {
  const file = notebookAnnotationsPath(sessionId, projectId);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const doc = raw.trim()
      ? (JSON.parse(raw) as NotebookAnnotationsDoc)
      : { version: 1 as const, annotations: [] };
    return { doc, mtime: fs.statSync(file).mtime };
  } catch {
    // Absent or corrupt sidecar → empty envelope (never fails the read).
    return { doc: { version: 1, annotations: [] }, mtime: null };
  }
}

/** Atomic write (tmp + rename); returns the sidecar's new mtime. */
export function writeNotebookAnnotations(
  sessionId: string,
  doc: NotebookAnnotationsDoc,
  projectId?: string,
): Date {
  const file = notebookAnnotationsPath(sessionId, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
  return fs.statSync(file).mtime;
}
