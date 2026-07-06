"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, DownloadIcon, PrinterIcon } from "lucide-react";
import { apiFetch, API_BASE, getActiveProjectId } from "@/lib/projects";
import { rawFileUrl, fileCategory } from "@/lib/use-sandbox";
import { mergeNotebookEntries, type NotebookEntry } from "@/lib/notebook";
import { LabNotebookEntryCard, TYPE_META } from "./lab-notebook-entry-card";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Builds a self-contained, print-ready HTML document from notebook entries. */
function buildNotebookPrintHtml(entries: NotebookEntry[]): string {
  const entryHtml = entries
    .map((entry) => {
      const typeLabel = TYPE_META[entry.type]?.label ?? entry.type;
      const time = new Date(entry.timestamp).toLocaleString();
      const body = entry.body
        ? `<div class="body">${escapeHtml(entry.body)}</div>`
        : "";
      const code = entry.code
        ? `<pre class="code"><code>${escapeHtml(entry.code.source)}</code></pre>`
        : "";
      const artifacts = (entry.artifacts ?? [])
        .map((path) => {
          const url = rawFileUrl(path);
          if (fileCategory(path) === "image") {
            return `<figure class="artifact"><img src="${escapeHtml(url)}" alt="${escapeHtml(path)}" /><figcaption>${escapeHtml(path)}</figcaption></figure>`;
          }
          return `<div class="artifact-link"><a href="${escapeHtml(url)}">${escapeHtml(path)}</a></div>`;
        })
        .join("\n");
      return `
        <section class="entry">
          <div class="entry-meta">
            <span class="entry-type">${escapeHtml(typeLabel)}</span>
            <span class="entry-time">${escapeHtml(time)}</span>
          </div>
          <h2 class="entry-title">${escapeHtml(entry.title)}</h2>
          ${body}
          ${code}
          ${artifacts}
        </section>
      `;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Lab Notebook</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; margin: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .entry { break-inside: avoid; page-break-inside: avoid; border-top: 1px solid #ddd; padding: 1rem 0; }
  .entry:first-child { border-top: none; }
  .entry-meta { display: flex; justify-content: space-between; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #555; }
  .entry-title { font-size: 1.05rem; margin: 0.25rem 0 0.5rem; }
  .body { white-space: pre-wrap; font-size: 0.9rem; margin-bottom: 0.5rem; }
  .code { background: #f4f4f4; border-radius: 4px; padding: 0.6rem; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; }
  .artifact img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .artifact figcaption { font-size: 0.75rem; color: #666; margin-top: 0.25rem; }
  .artifact-link { font-size: 0.85rem; }
  @media print {
    body { margin: 0.5in; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <h1>Lab Notebook</h1>
  <div class="subtitle">Exported ${escapeHtml(new Date().toLocaleString())}</div>
  ${entryHtml}
</body>
</html>`;
}

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

  function handleExportPdf() {
    if (entries.length === 0) return;
    const html = buildNotebookPrintHtml(entries);
    const win = window.open("", "_blank");
    if (!win) return; // popup blocked: no-op
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  }

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
        {entries.length > 0 && (
          <button
            type="button"
            onClick={handleExportPdf}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted ${exportHref ? "" : "ml-auto"}`}
          >
            <PrinterIcon className="size-3" /> PDF
          </button>
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
