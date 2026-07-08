"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PencilLineIcon } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, getActiveProjectId } from "@/lib/projects";
import { mergeNotebookEntries, type NotebookEntry } from "@/lib/notebook";
import { deriveThreads } from "@/lib/notebook-threads";
import {
  countByType,
  EMPTY_FILTERS,
  filterEntries,
  isFiltering,
  type NotebookFilterState,
} from "@/lib/notebook-filters";
import { buildNotebookPrintHtml } from "@/lib/notebook-print";
import { useNotebookAnnotations } from "@/lib/use-notebook-annotations";
import { useNotebookPolling } from "@/lib/use-notebook-polling";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import {
  LabNotebookHeader,
  type NotebookExportFormat,
  type NotebookScope,
  type NotebookViewMode,
} from "./lab-notebook-header";
import { LabNotebookTimeline } from "./lab-notebook-timeline";

const VIEW_MODE_KEY = "kady:notebook:view";
const FOCUS_DEADLINE_MS = 4000;

interface SessionInfo {
  id?: string;
  name?: string | null;
  firstMessage?: string | null;
}

function sessionDisplayName(s: SessionInfo): string {
  const raw = (s.name ?? s.firstMessage ?? s.id ?? "").trim();
  return raw.length > 60 ? raw.slice(0, 57) + "…" : raw || String(s.id ?? "");
}

export function LabNotebookView({
  sessionId,
  liveEntries,
  streaming,
  subagentCompletions,
  onOpenFile,
  onJumpToChat,
  focusEntry,
}: {
  sessionId: string | null;
  liveEntries: NotebookEntry[];
  streaming: boolean;
  subagentCompletions: number;
  onOpenFile: (path: string) => void;
  /** Scroll the chat transcript to this entry's tool call. */
  onJumpToChat?: (entryId: string) => void;
  /** Deep-link target from the chat side; token forces re-focus on repeat. */
  focusEntry?: { id: string; token: number } | null;
}) {
  const [fetched, setFetched] = useState<NotebookEntry[]>([]);
  const [scope, setScope] = useState<NotebookScope>("session");
  const [viewMode, setViewMode] = useState<NotebookViewMode>("agents");
  const [filters, setFilters] = useState<NotebookFilterState>(EMPTY_FILTERS);
  const [projectEntries, setProjectEntries] = useState<NotebookEntry[]>([]);
  const [sessionNames, setSessionNames] = useState<Map<string, string>>(new Map());
  const [methodsBusy, setMethodsBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const reduced = usePrefersReducedMotion();

  // Always holds the *current* sessionId, independent of which effect's
  // closure a given refetch() call happened to capture. Updated on every
  // render (not just in the sessionId effect) so it's current even while
  // other effects' async work is in flight.
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;
  const inFlightRef = useRef(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      if (v === "chrono" || v === "agents") setViewMode(v);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const changeViewMode = useCallback((v: NotebookViewMode) => {
    setViewMode(v);
    try {
      localStorage.setItem(VIEW_MODE_KEY, v);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const refetch = useCallback(() => {
    let cancelled = false;
    const capturedSessionId = sessionId;
    if (!sessionId) {
      setFetched([]);
      return () => { cancelled = true; };
    }
    if (inFlightRef.current) return () => { cancelled = true; };
    inFlightRef.current = true;
    (async () => {
      try {
        const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/notebook`);
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: NotebookEntry[] };
        // Guard against a response for a session we've since navigated away
        // from (e.g. a subagentCompletions- or run-end-triggered fetch for
        // session A resolving after sessionId has moved to B). `cancelled`
        // only covers the effect that kicked this call off unmounting/
        // re-running; `currentSessionRef` covers the cross-effect race.
        if (!cancelled && capturedSessionId === currentSessionRef.current && Array.isArray(data.entries)) {
          setFetched(data.entries);
        }
      } catch {
        // Non-fatal: live entries still render.
      } finally {
        inFlightRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // Cold-open/reload on session change, and re-pull when a subagent completes
  // (its harvested entries are now in the durable notebook).
  useEffect(() => {
    if (sessionId) setFetched([]); // clear only on a real session switch
    const cleanup = refetch();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (subagentCompletions > 0) return refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentCompletions]);

  // The subagentCompletions signal fires on tool_end[subagent], which for
  // async/background subagents corresponds to dispatch, not completion (async
  // completion is delivered off the SSE stream). Re-fetch on run-end too, so
  // entries harvested by an async child mid-run still surface once the parent
  // run finishes. The polling hook below covers the residual gap (a child
  // finishing after the parent run ends).
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    if (wasStreamingRef.current && !streaming) cleanup = refetch();
    wasStreamingRef.current = streaming;
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const canAnnotate = scope === "session" && Boolean(sessionId);
  const {
    pinnedIds,
    commentsByEntry,
    notes,
    annotations,
    togglePin,
    addComment,
    addNote,
  } = useNotebookAnnotations(sessionId, canAnnotate);

  // Poll while async subagent work may still land entries post-run.
  const hasSubagentActivity =
    subagentCompletions > 0 || fetched.some((e) => e.role && e.role !== "agent");
  useNotebookPolling({
    enabled: scope === "session" && Boolean(sessionId) && hasSubagentActivity,
    refetch,
    signature: fetched.map((e) => e.id).join(","),
    resetKey: subagentCompletions * 2 + (streaming ? 1 : 0),
  });

  // Project scope: merged read-only view across all sessions.
  useEffect(() => {
    if (scope !== "project") return;
    let cancelled = false;
    (async () => {
      try {
        const pid = getActiveProjectId();
        const [nbRes, sessRes] = await Promise.all([
          apiFetch(`/projects/${encodeURIComponent(pid)}/notebook`),
          apiFetch(`/sessions`),
        ]);
        if (!nbRes.ok) throw new Error(`project notebook failed: ${nbRes.status}`);
        const nb = (await nbRes.json()) as { entries?: NotebookEntry[] };
        const names = new Map<string, string>();
        if (sessRes.ok) {
          const sessions = (await sessRes.json()) as SessionInfo[];
          if (Array.isArray(sessions)) {
            for (const s of sessions) if (s?.id) names.set(String(s.id), sessionDisplayName(s));
          }
        }
        if (!cancelled) {
          setProjectEntries(Array.isArray(nb.entries) ? nb.entries : []);
          setSessionNames(names);
        }
      } catch {
        if (!cancelled) {
          toast.error("Couldn't load the project notebook.");
          setScope("session");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

  // User notes render as synthetic entries so they flow through the timeline.
  const noteEntries = useMemo<NotebookEntry[]>(
    () =>
      notes.map((a) => ({
        id: `note-${a.id}`,
        type: "note" as const,
        title: a.title?.trim() || "Note",
        body: a.body,
        timestamp: a.createdAt,
        role: "you",
      })),
    [notes],
  );

  // Authoritative (fetched) entries win over provisional (live) ones by id.
  const sessionEntries = useMemo(
    () => mergeNotebookEntries(mergeNotebookEntries(liveEntries, fetched), noteEntries),
    [liveEntries, fetched, noteEntries],
  );
  const displayEntries = scope === "project" ? projectEntries : sessionEntries;

  const threads = useMemo(() => deriveThreads(displayEntries), [displayEntries]);
  const entryById = useMemo(
    () => new Map(displayEntries.map((e) => [e.id, e])),
    [displayEntries],
  );
  const visible = useMemo(
    () => filterEntries(displayEntries, filters, pinnedIds),
    [displayEntries, filters, pinnedIds],
  );
  // Counts come from the search/pinned-filtered set (NOT type-filtered), so
  // toggling a type chip doesn't zero out the other chips.
  const typeCounts = useMemo(
    () =>
      countByType(
        filterEntries(
          displayEntries,
          { ...filters, types: new Set() },
          pinnedIds,
        ),
      ),
    [displayEntries, filters, pinnedIds],
  );

  // --- Deep-link focus (chat → notebook, and thread-reference jumps) ---
  const pendingFocusRef = useRef<string | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tryFocus = useCallback(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const el = document.querySelector(`[data-testid="nb-entry-${CSS.escape(id)}"]`);
    if (!el) return;
    pendingFocusRef.current = null;
    if (focusTimerRef.current) {
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    el.classList.add("kady-flash");
    setTimeout(() => el.classList.remove("kady-flash"), 1800);
  }, [reduced]);

  const focusById = useCallback(
    (id: string) => {
      pendingFocusRef.current = id;
      // A hidden target is most often filtered out — reset filters, then look.
      setFilters((f) => (isFiltering(f) ? EMPTY_FILTERS : f));
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      focusTimerRef.current = setTimeout(() => {
        if (pendingFocusRef.current === id) {
          pendingFocusRef.current = null;
          toast.error("That notebook entry isn't in this chat's notebook.");
        }
      }, FOCUS_DEADLINE_MS);
      requestAnimationFrame(tryFocus);
    },
    [tryFocus],
  );

  const focusToken = focusEntry?.token;
  useEffect(() => {
    if (focusEntry && focusToken !== undefined) focusById(focusEntry.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  // Retry pending focus whenever the rendered set changes (refetch landing).
  useEffect(() => {
    tryFocus();
  }, [visible, tryFocus]);

  useEffect(
    () => () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    },
    [],
  );

  // --- Header actions ---
  async function handleExport(format: NotebookExportFormat) {
    if (!sessionId) return;
    try {
      const res = await apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}/notebook/export?format=${format}`,
      );
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lab-notebook-${sessionId}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export failed.");
    }
  }

  function handlePrint() {
    if (displayEntries.length === 0) return;
    const html = buildNotebookPrintHtml(displayEntries, {
      scope,
      sessionNames: scope === "project" ? sessionNames : undefined,
      annotations,
    });
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Pop-up blocked — allow pop-ups to export a PDF.");
      return;
    }
    win.document.write(html);
    win.document.close();
    const go = () => {
      win.focus();
      win.print();
    };
    // Wait for load so artifact images land before the print dialog snapshots.
    if (win.document.readyState === "complete") go();
    else win.addEventListener("load", go);
  }

  async function runMethodsDraft() {
    if (!sessionId || methodsBusy) return;
    setMethodsBusy(true);
    try {
      const res = await apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}/notebook/methods-draft`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        path?: string;
        costUsd?: number;
        message?: string;
      };
      if (res.status === 402) {
        toast.error("Project spend limit reached — raise it in project settings.");
        return;
      }
      if (!res.ok) {
        toast.error(data.message ?? "Methods draft failed.");
        return;
      }
      toast.success(
        typeof data.costUsd === "number"
          ? `Methods draft saved ($${data.costUsd.toFixed(4)})`
          : "Methods draft saved",
      );
      if (typeof data.path === "string") onOpenFile(data.path);
    } catch {
      toast.error("Methods draft failed.");
    } finally {
      setMethodsBusy(false);
    }
  }

  function submitNote() {
    const body = noteDraft.trim();
    if (!body) return;
    addNote(body);
    setNoteDraft("");
  }

  return (
    <div className="flex h-full flex-col">
      <LabNotebookHeader
        streaming={streaming}
        scope={scope}
        onScopeChange={setScope}
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        filters={filters}
        onFiltersChange={setFilters}
        typeCounts={typeCounts}
        totalCount={displayEntries.length}
        filteredCount={visible.length}
        canAnnotate={canAnnotate}
        onExport={handleExport}
        onPrint={handlePrint}
        methods={{
          enabled: Boolean(sessionId) && sessionEntries.length > 0,
          busy: methodsBusy,
          run: runMethodsDraft,
        }}
      />
      {displayEntries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          {scope === "project"
            ? "No notebook entries in this project yet."
            : "Kady’s notebook — entries appear here as it works."}
        </div>
      ) : (
        <LabNotebookTimeline
          entries={visible}
          viewMode={viewMode}
          scope={scope}
          sessionNames={scope === "project" ? sessionNames : undefined}
          threads={threads}
          entryById={entryById}
          pinnedIds={pinnedIds}
          commentsByEntry={commentsByEntry}
          canAnnotate={canAnnotate}
          reducedMotion={reduced}
          callbacks={{
            onOpenFile,
            onTogglePin: togglePin,
            onAddComment: addComment,
            onJumpToChat,
            onJumpToEntry: focusById,
            onTagClick: (tag) => setFilters((f) => ({ ...f, query: tag })),
          }}
        />
      )}
      {canAnnotate && (
        <div className="flex items-center gap-2 border-t px-4 py-2">
          <PencilLineIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNote();
            }}
            placeholder="Add a note to the lab notebook… (Enter to save)"
            aria-label="Add a note"
            className="flex-1 rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-foreground/30"
          />
          <button
            type="button"
            onClick={submitNote}
            disabled={!noteDraft.trim()}
            className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            Add note
          </button>
        </div>
      )}
    </div>
  );
}
