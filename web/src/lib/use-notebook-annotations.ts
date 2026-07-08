"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { apiFetch } from "@/lib/projects";
import {
  applyOp,
  derive,
  EMPTY_DOC,
  type AnnotationOp,
  type AnnotationsDoc,
  type NotebookAnnotation,
} from "./notebook-annotations";

function normalizeDoc(data: unknown): AnnotationsDoc {
  const anns = (data as { annotations?: unknown } | null)?.annotations;
  return { version: 1, annotations: Array.isArray(anns) ? (anns as NotebookAnnotation[]) : [] };
}

/**
 * User annotations (pins/comments/notes) for a session's notebook, persisted
 * in the server sidecar. Optimistic apply; saves are serialized on a promise
 * chain; a 412 (concurrent write) rebases the op on the fresh doc and retries
 * once, after which the local state reverts to the server's copy.
 */
export function useNotebookAnnotations(sessionId: string | null, enabled: boolean) {
  const [doc, setDoc] = useState<AnnotationsDoc>(EMPTY_DOC);
  const [saving, setSaving] = useState(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const lastModifiedRef = useRef<string | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;

  useEffect(() => {
    setDoc(EMPTY_DOC);
    lastModifiedRef.current = null;
    if (!enabled || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(
          `/sessions/${encodeURIComponent(sessionId)}/notebook/annotations`,
        );
        if (!res.ok) return; // absent sidecar → keep empty envelope
        const data = normalizeDoc(await res.json());
        if (!cancelled && sessionId === currentSessionRef.current) {
          // Merge rather than replace: an optimistic mutation made while this
          // GET was in flight (e.g. a note added right after opening the
          // notebook) must not be clobbered by the server's older copy.
          setDoc((cur) => {
            if (cur.annotations.length === 0) return data;
            const serverIds = new Set(data.annotations.map((a) => a.id));
            return {
              version: 1,
              annotations: [
                ...data.annotations,
                ...cur.annotations.filter((a) => !serverIds.has(a.id)),
              ],
            };
          });
          lastModifiedRef.current = res.headers.get("Last-Modified");
        }
      } catch {
        // Non-fatal: annotations stay empty for this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled]);

  const mutate = useCallback((op: AnnotationOp) => {
    const sid = currentSessionRef.current;
    if (!sid) return;
    setDoc((d) => applyOp(d, op));
    const url = `/sessions/${encodeURIComponent(sid)}/notebook/annotations`;
    queueRef.current = queueRef.current.then(async () => {
      if (sid !== currentSessionRef.current) return; // session switched — drop
      setSaving(true);
      const put = (payload: AnnotationsDoc) =>
        apiFetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(lastModifiedRef.current
              ? { "If-Unmodified-Since": lastModifiedRef.current }
              : {}),
          },
          body: JSON.stringify(payload),
        });
      try {
        let res = await put(docRef.current);
        if (res.status === 412) {
          // Someone else wrote the sidecar: rebase this op on their copy.
          const fres = await apiFetch(url);
          const fresh = fres.ok ? normalizeDoc(await fres.json()) : EMPTY_DOC;
          lastModifiedRef.current = fres.ok ? fres.headers.get("Last-Modified") : null;
          const rebased = applyOp(fresh, op);
          if (sid === currentSessionRef.current) setDoc(rebased);
          res = await put(rebased);
        }
        if (res.ok) {
          lastModifiedRef.current = res.headers.get("Last-Modified");
        } else {
          throw new Error(`save failed: ${res.status}`);
        }
      } catch {
        toast.error("Couldn't save your annotation — reloaded from disk.");
        try {
          const fres = await apiFetch(url);
          if (fres.ok && sid === currentSessionRef.current) {
            setDoc(normalizeDoc(await fres.json()));
            lastModifiedRef.current = fres.headers.get("Last-Modified");
          }
        } catch {
          /* keep optimistic state; next save retries */
        }
      } finally {
        setSaving(false);
      }
    });
  }, []);

  const derived = useMemo(() => derive(doc), [doc]);

  const togglePin = useCallback(
    (entryId: string) => {
      const existing = derived.pinIdByEntry.get(entryId);
      if (existing) mutate({ op: "remove", id: existing });
      else {
        mutate({
          op: "add",
          annotation: { id: nanoid(), kind: "pin", entryId, createdAt: Date.now() },
        });
      }
    },
    [derived, mutate],
  );

  const addComment = useCallback(
    (entryId: string, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      mutate({
        op: "add",
        annotation: { id: nanoid(), kind: "comment", entryId, body: trimmed, createdAt: Date.now() },
      });
    },
    [mutate],
  );

  const addNote = useCallback(
    (body: string, title?: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      mutate({
        op: "add",
        annotation: {
          id: nanoid(),
          kind: "note",
          body: trimmed,
          ...(title?.trim() ? { title: title.trim() } : {}),
          createdAt: Date.now(),
        },
      });
    },
    [mutate],
  );

  return {
    pinnedIds: derived.pinnedIds,
    commentsByEntry: derived.commentsByEntry,
    notes: derived.notes,
    annotations: doc.annotations,
    togglePin,
    addComment,
    addNote,
    saving,
  };
}
