/**
 * Durable PDF annotation sidecars shared by the HTTP API, lead agent tools,
 * and child-agent Pi package.
 *
 * Every writer takes the same cross-process lock and replaces the JSON file
 * atomically. This prevents a user save and an agent annotation from
 * corrupting or silently overwriting each other.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface PdfAnnotationAuthor {
  kind: "user" | "expert";
  id: string;
  label: string;
}

export interface PdfAnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfHighlightAnnotation {
  id: string;
  type: "highlight";
  page: number;
  rects: PdfAnnotationRect[];
  text: string;
  color?: string;
  note?: string;
  author: PdfAnnotationAuthor;
  createdAt: string;
}

export interface PdfNoteAnnotation {
  id: string;
  type: "note";
  page: number;
  anchor: { x: number; y: number };
  body: string;
  color?: string;
  author: PdfAnnotationAuthor;
  createdAt: string;
}

export type PdfAnnotation = PdfHighlightAnnotation | PdfNoteAnnotation;

export interface PdfAnnotationsDoc {
  version: 1;
  annotations: PdfAnnotation[];
}

export class PdfAnnotationStoreError extends Error {
  code: "INVALID_PATH" | "NOT_FOUND" | "NOT_PDF" | "CONFLICT" | "LOCK_TIMEOUT";

  constructor(
    code: PdfAnnotationStoreError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const EMPTY_DOC = (): PdfAnnotationsDoc => ({ version: 1, annotations: [] });
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

function isWithin(root: string, target: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = normalize(root);
  const normalizedTarget = normalize(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(normalizedRoot + path.sep)
  );
}

function resolvePdf(sandboxRoot: string, pdfPath: string): string {
  if (!pdfPath?.trim() || path.isAbsolute(pdfPath)) {
    throw new PdfAnnotationStoreError(
      "INVALID_PATH",
      "pdf_path must be a sandbox-relative path",
    );
  }
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, pdfPath);
  if (!isWithin(root, target) || target.endsWith(".annotations.json")) {
    throw new PdfAnnotationStoreError("INVALID_PATH", "Path traversal denied");
  }

  // Resolve symlinks too: lexical containment alone is not enough.
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    if (!isWithin(fs.realpathSync(root), fs.realpathSync(existing))) {
      throw new PdfAnnotationStoreError("INVALID_PATH", "Path traversal denied");
    }
  } catch (error) {
    if (error instanceof PdfAnnotationStoreError) throw error;
  }

  if (path.extname(target).toLowerCase() !== ".pdf") {
    throw new PdfAnnotationStoreError("NOT_PDF", "pdf_path must point to a PDF");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new PdfAnnotationStoreError(
      "NOT_FOUND",
      `PDF not found: ${pdfPath}`,
    );
  }
  return target;
}

export function pdfAnnotationSidecarPath(
  sandboxRoot: string,
  pdfPath: string,
): string {
  return `${resolvePdf(sandboxRoot, pdfPath)}.annotations.json`;
}

function normalizeDoc(value: unknown): PdfAnnotationsDoc {
  if (!value || typeof value !== "object") return EMPTY_DOC();
  const annotations = (value as { annotations?: unknown }).annotations;
  if (!Array.isArray(annotations)) return EMPTY_DOC();
  return { version: 1, annotations: annotations as PdfAnnotation[] };
}

function readSidecar(sidecar: string): PdfAnnotationsDoc {
  try {
    const raw = fs.readFileSync(sidecar, "utf-8");
    return normalizeDoc(raw.trim() ? JSON.parse(raw) : {});
  } catch {
    return EMPTY_DOC();
  }
}

/**
 * Strong validator for a sidecar's current contents.
 *
 * Last-Modified only has one-second resolution, which is why the old
 * precondition had to tolerate a second of drift — and therefore silently
 * accepted writes made against a version that had already changed. A content
 * hash has no such blind window.
 */
function sidecarEtag(sidecar: string): string | null {
  try {
    return `"${createHash("sha256").update(fs.readFileSync(sidecar)).digest("hex").slice(0, 32)}"`;
  } catch {
    return null;
  }
}

export function readPdfAnnotations(
  sandboxRoot: string,
  pdfPath: string,
): { doc: PdfAnnotationsDoc; mtime: Date | null; etag: string | null } {
  const sidecar = pdfAnnotationSidecarPath(sandboxRoot, pdfPath);
  if (!fs.existsSync(sidecar)) return { doc: EMPTY_DOC(), mtime: null, etag: null };
  return {
    doc: readSidecar(sidecar),
    mtime: fs.statSync(sidecar).mtime,
    etag: sidecarEtag(sidecar),
  };
}

function writeSidecar(sidecar: string, doc: PdfAnnotationsDoc): Date {
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  const tmp = `${sidecar}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, sidecar);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup after a failed write/rename.
    }
  }
  return fs.statSync(sidecar).mtime;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** First line of a lock file — the holder's unique token — or null if unreadable. */
function readLockToken(lock: string): string | null {
  try {
    return fs.readFileSync(lock, "utf-8").split("\n")[0] || null;
  } catch {
    return null;
  }
}

async function acquireLock(sidecar: string): Promise<() => void> {
  const lock = path.join(
    path.dirname(sidecar),
    `.${path.basename(sidecar)}.lock`,
  );
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    // Each holder stamps a unique token so neither release nor stale-recovery
    // can remove a lock that now belongs to someone else.
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, `${token}\n${Date.now()}\n`, "utf-8");
      return () => {
        try {
          fs.closeSync(fd);
        } finally {
          try {
            if (readLockToken(lock) === token) fs.rmSync(lock, { force: true });
          } catch {
            // Another process can recover this lock after it becomes stale.
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Only clear the exact lock we observed as stale. (A fresh lock
          // taken between this read and the unlink would still be lost, but
          // that requires a holder to have already hung past LOCK_STALE_MS.)
          const stale = readLockToken(lock);
          if (stale !== null && readLockToken(lock) === stale) {
            fs.rmSync(lock, { force: true });
          }
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new PdfAnnotationStoreError(
          "LOCK_TIMEOUT",
          "Timed out waiting to update PDF annotations",
        );
      }
      await delay(20);
    }
  }
}

export async function mutatePdfAnnotations<T>(
  sandboxRoot: string,
  pdfPath: string,
  mutate: (doc: PdfAnnotationsDoc) => { doc: PdfAnnotationsDoc; value: T },
): Promise<{ value: T; doc: PdfAnnotationsDoc; mtime: Date }> {
  const sidecar = pdfAnnotationSidecarPath(sandboxRoot, pdfPath);
  const release = await acquireLock(sidecar);
  try {
    const result = mutate(readSidecar(sidecar));
    const doc = normalizeDoc(result.doc);
    const mtime = writeSidecar(sidecar, doc);
    return { value: result.value, doc, mtime };
  } finally {
    release();
  }
}

export interface AnnotationPrecondition {
  /** Strong validator from a previous read (If-Match). Preferred. */
  etag?: string | null;
  /** Second-resolution fallback (If-Unmodified-Since). */
  ifUnmodifiedSince?: string | null;
}

export async function replacePdfAnnotations(
  sandboxRoot: string,
  pdfPath: string,
  doc: PdfAnnotationsDoc,
  precondition?: AnnotationPrecondition | string | null,
): Promise<{ doc: PdfAnnotationsDoc; mtime: Date; etag: string | null }> {
  const expected: AnnotationPrecondition =
    typeof precondition === "string" || precondition === null || precondition === undefined
      ? { ifUnmodifiedSince: precondition ?? null }
      : precondition;
  const sidecar = pdfAnnotationSidecarPath(sandboxRoot, pdfPath);
  const release = await acquireLock(sidecar);
  try {
    const exists = fs.existsSync(sidecar);
    if (expected.etag) {
      // "*" means "must already exist"; anything else must match exactly.
      const current = exists ? sidecarEtag(sidecar) : null;
      const ok = expected.etag === "*" ? exists : current === expected.etag;
      if (!ok) {
        throw new PdfAnnotationStoreError(
          "CONFLICT",
          "Sidecar modified; re-read and retry",
        );
      }
    } else if (expected.ifUnmodifiedSince && exists) {
      const since = new Date(expected.ifUnmodifiedSince).getTime();
      const actual = fs.statSync(sidecar).mtime.getTime();
      // Compare whole seconds: the header cannot express more, and the old
      // `actual - expected > 1000` check let any write inside a full second
      // past the client's version through as if nothing had changed.
      if (!Number.isNaN(since) && Math.floor(actual / 1000) > Math.floor(since / 1000)) {
        throw new PdfAnnotationStoreError(
          "CONFLICT",
          "Sidecar modified; re-read and retry",
        );
      }
    }
    const normalized = normalizeDoc(doc);
    const mtime = writeSidecar(sidecar, normalized);
    return { doc: normalized, mtime, etag: sidecarEtag(sidecar) };
  } finally {
    release();
  }
}
