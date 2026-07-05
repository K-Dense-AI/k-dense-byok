"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, DownloadIcon } from "lucide-react";
import { apiFetch, API_BASE, getActiveProjectId } from "@/lib/projects";
import { mergeNotebookEntries, type NotebookEntry } from "@/lib/notebook";
import { LabNotebookEntryCard } from "./lab-notebook-entry-card";

export function LabNotebookView({
  sessionId,
  liveEntries,
  streaming,
  onOpenFile,
}: {
  sessionId: string | null;
  liveEntries: NotebookEntry[];
  streaming: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [fetched, setFetched] = useState<NotebookEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Cold-open / reload: pull the durable entries whenever the session changes.
  useEffect(() => {
    let cancelled = false;
    setFetched([]);
    if (!sessionId) return;
    (async () => {
      try {
        const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/notebook`);
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: NotebookEntry[] };
        if (!cancelled && Array.isArray(data.entries)) setFetched(data.entries);
      } catch {
        // Non-fatal: live entries still render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Authoritative (fetched) entries win over provisional (live) ones by id.
  const entries = useMemo(
    () => mergeNotebookEntries(liveEntries, fetched),
    [liveEntries, fetched],
  );

  // Auto-scroll to the newest entry as it streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  const exportHref = sessionId
    ? `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/notebook/export?format=md&project=${encodeURIComponent(getActiveProjectId())}`
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
        <BookOpenIcon className="size-4" />
        <span className="font-medium">Lab Notebook</span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            writing…
          </span>
        )}
        {exportHref && entries.length > 0 && (
          <a
            href={exportHref}
            download={`lab-notebook-${sessionId}.md`}
            className="ml-auto inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
          >
            <DownloadIcon className="size-3" /> Export
          </a>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Kady’s notebook — entries appear here as it works.
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
            >
              <LabNotebookEntryCard entry={entry} onOpenFile={onOpenFile} />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
