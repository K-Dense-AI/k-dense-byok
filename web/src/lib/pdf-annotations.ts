"use client";

import { apiFetch } from "@/lib/projects";

// ---------------------------------------------------------------------------
// Annotation schema — shared between the frontend viewer and the expert-side
// MCP server. Coordinates are in PDF user-space points (origin bottom-left,
// y grows upward), page-local. The viewer converts to CSS pixels at render
// time using pdfjs viewport transforms so annotations stay aligned across
// zoom levels.
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  x: number;
  y: number;
}

export type AuthorKind = "user" | "expert";

export interface Author {
  kind: AuthorKind;
  id: string;
  label: string;
}

export interface HighlightAnnotation {
  id: string;
  type: "highlight";
  page: number;
  rects: Rect[];
  text: string;
  color: string;
  note?: string;
  author: Author;
  createdAt: string;
}

export interface NoteAnnotation {
  id: string;
  type: "note";
  page: number;
  anchor: Anchor;
  body: string;
  color: string;
  author: Author;
  createdAt: string;
}

export type Annotation = HighlightAnnotation | NoteAnnotation;

export interface AnnotationsDoc {
  version: 1;
  annotations: Annotation[];
}

export const EMPTY_DOC: AnnotationsDoc = { version: 1, annotations: [] };

export const USER_COLOR = "#fde68a";

// Small palette used to derive colors for expert authors by hashing their id.
const EXPERT_PALETTE = [
  "#93c5fd", // blue
  "#c4b5fd", // violet
  "#fca5a5", // red
  "#86efac", // green
  "#f9a8d4", // pink
  "#fdba74", // orange
  "#67e8f9", // cyan
  "#a5b4fc", // indigo
];

export function colorForAuthor(a: Author): string {
  if (a.kind === "user") return USER_COLOR;
  let h = 0;
  for (let i = 0; i < a.id.length; i++) {
    h = (h * 31 + a.id.charCodeAt(i)) | 0;
  }
  return EXPERT_PALETTE[Math.abs(h) % EXPERT_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface FetchResult {
  doc: AnnotationsDoc;
  lastModified: string | null;
}

export async function fetchAnnotations(
  path: string,
  projectId?: string,
): Promise<FetchResult> {
  const res = await apiFetch(
    `/sandbox/annotations?path=${encodeURIComponent(path)}`,
    {},
    projectId,
  );
  if (!res.ok) {
    return { doc: { ...EMPTY_DOC }, lastModified: null };
  }
  const doc = (await res.json()) as AnnotationsDoc;
  const lastModified = res.headers.get("Last-Modified");
  return {
    doc: { version: 1, annotations: doc.annotations ?? [] },
    lastModified,
  };
}

export interface SaveResult {
  ok: boolean;
  conflict: boolean;
  lastModified: string | null;
}

export async function saveAnnotations(
  path: string,
  doc: AnnotationsDoc,
  ifUnmodifiedSince: string | null,
  projectId?: string,
): Promise<SaveResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ifUnmodifiedSince) headers["If-Unmodified-Since"] = ifUnmodifiedSince;

  const res = await apiFetch(
    `/sandbox/annotations?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(doc),
    },
    projectId,
  );
  if (res.status === 412) {
    return { ok: false, conflict: true, lastModified: null };
  }
  return {
    ok: res.ok,
    conflict: false,
    lastModified: res.headers.get("Last-Modified"),
  };
}

// Poll the sidecar for external writes (e.g. from the expert-side MCP).
// Returns a cleanup function. The callback is invoked with the freshest
// doc whenever Last-Modified changes.
export function subscribeAnnotations(
  path: string,
  initialLastModified: string | null,
  onChange: (result: FetchResult) => void,
  intervalMs = 3000,
  projectId?: string,
): () => void {
  let cancelled = false;
  let last = initialLastModified;

  const tick = async () => {
    if (cancelled) return;
    try {
      const res = await apiFetch(
        `/sandbox/annotations?path=${encodeURIComponent(path)}`,
        {},
        projectId,
      );
      if (!res.ok) return;
      const lastModified = res.headers.get("Last-Modified");
      if (lastModified !== last) {
        const doc = (await res.json()) as AnnotationsDoc;
        last = lastModified;
        if (!cancelled) {
          onChange({
            doc: { version: 1, annotations: doc.annotations ?? [] },
            lastModified,
          });
        }
      }
    } catch {
      // swallow transient errors
    }
  };

  const handle = setInterval(tick, intervalMs);
  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newAnnotationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const USER_AUTHOR: Author = {
  kind: "user",
  id: "local",
  label: "You",
};
