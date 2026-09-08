"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, BookOpenIcon, StickyNoteIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { apiFetch, useProjectScopeId } from "@/lib/projects";
import {
  mergeNotebookEntries,
  notebookEntryKey,
  type NotebookEntry,
} from "@/lib/notebook";
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
import { useNotebookData } from "@/lib/use-notebook-data";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import {
  LabNotebookHeader,
  type NotebookExportFormat,
  type NotebookOverview,
  type NotebookScope,
  type NotebookViewMode,
} from "./lab-notebook-header";
import { LabNotebookTimeline } from "./lab-notebook-timeline";
import { TYPE_META } from "./lab-notebook-entry-card";
import { NotebookMemoryDialog } from "./notebook-memory-dialog";
import { EvidencePackageDialog } from "./evidence-package-dialog";

const VIEW_MODE_KEY = "kady:notebook:view:v2";
const FOCUS_DEADLINE_MS = 4000;
/** Delays at which a focus jump re-asserts its target (see `tryFocus`). */
const FOCUS_REASSERT_MS = [120, 400, 1000];

/** True when `el` overlaps the viewport of its nearest scrollable ancestor. */
function inScrollView(el: Element): boolean {
  let parent = el.parentElement;
  while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
  const bounds = parent?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const rect = el.getBoundingClientRect();
  return rect.bottom > bounds.top && rect.top < bounds.bottom;
}

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
  projectId,
  model,
  sessionId,
  liveEntries,
  streaming,
  subagentCompletions,
  onOpenFile,
  onJumpToChat,
  focusEntry,
}: {
  projectId?: string;
  model?: string;
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
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [scope, setScope] = useState<NotebookScope>("project");
  const [viewMode, setViewMode] = useState<NotebookViewMode>("story");
  const [filters, setFilters] = useState<NotebookFilterState>(EMPTY_FILTERS);
  const [sessionNames, setSessionNames] = useState<Map<string, string>>(new Map());
  const [methodsBusy, setMethodsBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const reduced = usePrefersReducedMotion();

  const revision = `${subagentCompletions}:${streaming}`;
  const sessionData = useNotebookData({ projectId: scopedProjectId,
    url: sessionId ? `/sessions/${encodeURIComponent(sessionId)}/notebook` : null,
    revision, poll: scope === "session", active: streaming || subagentCompletions > 0 });
  const projectData = useNotebookData({ projectId: scopedProjectId,
    url: scope === "project" ? `/projects/${encodeURIComponent(scopedProjectId)}/notebook` : null,
    revision, poll: true, active: streaming || subagentCompletions > 0 });
  const fetched = sessionData.entries;
  const displayedData = scope === "project" ? projectData : sessionData;

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      if (v === "story" || v === "chrono" || v === "agents") setViewMode(v);
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

  const canAnnotate = scope === "session" && Boolean(sessionId);
  const {
    pinnedIds,
    commentsByEntry,
    notes,
    annotations,
    togglePin,
    addComment,
    addNote,
  } = useNotebookAnnotations(sessionId, canAnnotate, scopedProjectId);

  // Labels are cosmetic; a failed label lookup must not hide notebook data.
  useEffect(() => {
    if (scope !== "project") return;
    let cancelled = false;
    (async () => {
      try {
        const sessRes = await apiFetch(`/sessions`, {}, scopedProjectId);
        const names = new Map<string, string>();
        if (sessRes.ok) {
          const sessions = (await sessRes.json()) as SessionInfo[];
          if (Array.isArray(sessions)) {
            for (const s of sessions) if (s?.id) names.set(String(s.id), sessionDisplayName(s));
          }
        }
        if (!cancelled) {
          setSessionNames(names);
        }
      } catch {
        if (!cancelled) setSessionNames(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [scope, scopedProjectId]);

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
  // The project stream has no separate SSE channel. Overlay this chat's live
  // entries immediately, then let authoritative project rows win by scoped id.
  const displayEntries = useMemo(() => scope === "project"
    ? mergeNotebookEntries(
        sessionId ? sessionEntries.filter((e) => e.role !== "you").map((e) => ({ ...e, sessionId })) : [],
        projectData.entries,
      )
    : sessionEntries, [scope, sessionEntries, sessionId, projectData.entries]);

  const threads = useMemo(() => deriveThreads(displayEntries), [displayEntries]);
  const entryById = useMemo(
    () => new Map(displayEntries.map((e) => [notebookEntryKey(e), e])),
    [displayEntries],
  );
  const overview = useMemo<NotebookOverview>(() => {
    const artifacts = new Set<string>();
    const collaborators = new Set<string>();
    const tags = new Map<string, number>();
    const hypotheses = { open: 0, supported: 0, refuted: 0, mixed: 0, inconclusive: 0 };
    let latestObservation: NotebookOverview["latestObservation"];
    let latestDecision: NotebookOverview["latestDecision"];
    let updatedAt: number | undefined;

    for (const entry of displayEntries) {
      for (const artifact of entry.artifacts ?? []) artifacts.add(artifact);
      collaborators.add(entry.role ?? "agent");
      for (const tag of entry.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
      if (entry.type === "hypothesis" && !threads.get(notebookEntryKey(entry))?.supersededBy) {
        const status = threads.get(notebookEntryKey(entry))?.status ?? "open";
        hypotheses[status]++;
      }
      if (entry.type === "observation") {
        latestObservation = { id: notebookEntryKey(entry), title: entry.title };
      }
      if (entry.type === "decision") {
        latestDecision = { id: notebookEntryKey(entry), title: entry.title };
      }
      updatedAt = updatedAt === undefined ? entry.timestamp : Math.max(updatedAt, entry.timestamp);
    }

    return {
      artifactCount: artifacts.size,
      collaboratorCount: collaborators.size,
      pinnedCount: displayEntries.filter((entry) => pinnedIds.has(entry.id)).length,
      hypotheses,
      topTags: [...tags.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([label, count]) => ({ label, count })),
      latestObservation,
      latestDecision,
      updatedAt,
    };
  }, [displayEntries, pinnedIds, threads]);
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
  const memorySuppressedFocusToken = useRef<number | undefined>(undefined);
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
    const scroll = (behavior: ScrollBehavior) => el.scrollIntoView({ block: "center", behavior });
    scroll(reduced ? "auto" : "smooth");
    // The timeline scrolls inside a stick-to-bottom container (Conversation,
    // resize="smooth"). When the jump had to reset an active filter the visible
    // set grows in the same commit, and that container's ResizeObserver then
    // animates to the bottom and overrides this scroll, leaving the reader at
    // the wrong end of the list. Re-assert the target once the observer has had
    // its turn; skip when the entry is already in view so the common case stays
    // a single smooth scroll. The last pass also catches lazily loaded artifact
    // thumbnails above the target reflowing the list after the first scroll.
    for (const delay of FOCUS_REASSERT_MS) {
      setTimeout(() => { if (el.isConnected && !inScrollView(el)) scroll("auto"); }, delay);
    }
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
    if (focusEntry && focusToken !== undefined && focusToken !== memorySuppressedFocusToken.current) focusById(scope === "project" && sessionId
      ? notebookEntryKey({ id: focusEntry.id, sessionId }) : focusEntry.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, scope, sessionId]);

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
  // Export follows the scope toggle, like Print does. Exporting the active
  // session while "All chats" is on screen silently hands back a different
  // (much smaller) document than the one the user is looking at.
  async function handleExport(format: NotebookExportFormat) {
    const target =
      scope === "project"
        ? { path: `/projects/${encodeURIComponent(scopedProjectId)}/notebook/export`, name: scopedProjectId }
        : sessionId
          ? { path: `/sessions/${encodeURIComponent(sessionId)}/notebook/export`, name: sessionId }
          : null;
    if (!target) {
      toast.error("Start a chat before exporting its notebook.");
      return;
    }
    try {
      const res = await apiFetch(`${target.path}?format=${format}`, {}, scopedProjectId);
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lab-notebook-${target.name}.${format}`;
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
      projectId: scopedProjectId,
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
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(model ? { model } : {}),
        },
        scopedProjectId,
      );
      const data = (await res.json().catch(() => ({}))) as {
        path?: string;
        costUsd?: number;
        billingMode?: string;
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
        data.billingMode === "subscription"
          ? "Methods draft saved (subscription usage)"
          : typeof data.costUsd === "number"
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
    <div className="flex min-h-0 flex-1 flex-col">
      <LabNotebookHeader
        packageControl={<EvidencePackageDialog projectId={scopedProjectId} candidates={displayEntries.filter((e) => !e.provisional && ["hypothesis", "method", "observation", "decision"].includes(e.type) && (e.sessionId ?? sessionId)).map((e) => ({ sessionId: e.sessionId ?? sessionId!, entryId: e.id, title: e.title, type: e.type }))} />}
        memory={<NotebookMemoryDialog projectId={scopedProjectId} activeSessionId={sessionId} onOpenFile={onOpenFile} onJump={(source) => {
          memorySuppressedFocusToken.current = focusToken;
          if (source.kind === "user-note") {
            if (source.sessionId !== sessionId) return;
            setScope("session");
            focusById(`note-${source.entryId}`);
          } else {
            setScope("project");
            projectData.refresh();
            focusById(notebookEntryKey({ id: source.entryId, sessionId: source.sessionId }));
          }
        }} />}
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
        overview={overview}
        canAnnotate={canAnnotate}
        canExport={scope === "project" || Boolean(sessionId)}
        onExport={handleExport}
        onPrint={handlePrint}
        onTagClick={(tag) => setFilters((current) => ({ ...current, query: tag }))}
        onEntryJump={focusById}
        methods={{
          enabled: Boolean(sessionId) && sessionEntries.length > 0,
          busy: methodsBusy,
          run: runMethodsDraft,
        }}
      />
      {displayedData.error && (
        <div role="alert" className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs">
          <span>Notebook refresh failed. Displayed evidence checks may be out of date.</span>
          <Button variant="outline" size="xs" onClick={displayedData.refresh}>Retry</Button>
        </div>
      )}
      {displayEntries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
            <BookOpenIcon className="size-6 text-muted-foreground/40" />
          </div>
          <div className="flex max-w-xs flex-col gap-1">
            <p className="text-xs font-medium">
              {scope === "project" ? "No entries in this project" : "Nothing recorded yet"}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {scope === "project"
                ? "Findings from every chat in this project collect here."
                : "Kady’s notebook — entries appear here as it works, linking hypotheses to evidence and decisions."}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-1">
            {(["hypothesis", "method", "observation", "decision"] as const).map((type) => {
              const meta = TYPE_META[type];
              return (
                <span
                  key={type}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  <meta.Icon className={cn("size-3", meta.chip)} />
                  {meta.label}
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <LabNotebookTimeline
          model={model}
          entries={visible}
          sessionId={sessionId ?? undefined}
          projectId={scopedProjectId}
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
            onResearchSaved: () => { sessionData.refresh(); projectData.refresh(); },
            onOpenFile,
            onTogglePin: togglePin,
            onAddComment: addComment,
            onJumpToChat: scope === "session" ? onJumpToChat : undefined,
            onJumpToEntry: focusById,
            onTagClick: (tag) => setFilters((f) => ({ ...f, query: tag })),
          }}
        />
      )}
      {canAnnotate && (
        <form
          className="flex shrink-0 items-center gap-1.5 border-t px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitNote();
          }}
        >
          <div className="relative flex min-w-0 flex-1 items-center">
            <StickyNoteIcon className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
            <Input
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitNote();
                }
              }}
              placeholder="Capture your own observation…"
              aria-label="Add a note"
              className="h-7 bg-background pl-8 text-[11px] shadow-none"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            disabled={!noteDraft.trim()}
            aria-label="Save note"
            title="Save note"
            onClick={submitNote}
          >
            <ArrowUpIcon />
          </Button>
        </form>
      )}
    </div>
  );
}
