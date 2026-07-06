"use client";
import { useState } from "react";
import {
  LightbulbIcon, FlaskConicalIcon, BarChart3Icon, SignpostIcon, StickyNoteIcon,
  ChevronRightIcon, FileIcon, ExternalLinkIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import type { NotebookEntry, NotebookEntryType } from "@/lib/notebook";

export const TYPE_META: Record<
  NotebookEntryType,
  { label: string; Icon: typeof LightbulbIcon; spine: string; chip: string }
> = {
  hypothesis: { label: "Hypothesis", Icon: LightbulbIcon, spine: "bg-amber-400", chip: "text-amber-600 dark:text-amber-400" },
  method: { label: "Method", Icon: FlaskConicalIcon, spine: "bg-blue-400", chip: "text-blue-600 dark:text-blue-400" },
  observation: { label: "Observation", Icon: BarChart3Icon, spine: "bg-emerald-400", chip: "text-emerald-600 dark:text-emerald-400" },
  decision: { label: "Decision", Icon: SignpostIcon, spine: "bg-purple-400", chip: "text-purple-600 dark:text-purple-400" },
  note: { label: "Note", Icon: StickyNoteIcon, spine: "bg-neutral-400", chip: "text-neutral-500" },
};

const CODE_FILE_RE = /\.(py|r|jl|sh|ts|js|ipynb|sql)$/i;

export function LabNotebookEntryCard({
  entry,
  onOpenFile,
}: {
  entry: NotebookEntry;
  onOpenFile: (path: string) => void;
}) {
  const meta = TYPE_META[entry.type];
  const [codeOpen, setCodeOpen] = useState(false);
  const codeFilePath = entry.artifacts?.[0];
  const showOpenAsFile = Boolean(entry.code && codeFilePath && CODE_FILE_RE.test(codeFilePath));
  return (
    <div className="relative pl-6" data-testid={`nb-entry-${entry.id}`} data-nb-type={entry.type}>
      <span className={`absolute left-0 top-0 h-full w-1 rounded ${meta.spine}`} aria-hidden />
      <div className="rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex items-center gap-2 text-xs">
          <meta.Icon className={`size-4 ${meta.chip}`} />
          <span className={`font-medium ${meta.chip}`}>{meta.label}</span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          {entry.confidence && (
            <span className="ml-auto rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {entry.confidence}
            </span>
          )}
        </div>
        <h4 className="mt-1 text-sm font-semibold">{entry.title}</h4>
        {entry.body && (
          <div className="mt-1 text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <MessageResponse>{entry.body}</MessageResponse>
          </div>
        )}
        {entry.code && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setCodeOpen((o) => !o)}
              >
                <ChevronRightIcon className={`size-3 transition-transform ${codeOpen ? "rotate-90" : ""}`} />
                {entry.code.lang ?? "code"}
              </button>
              {showOpenAsFile && (
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenFile(codeFilePath!)}
                >
                  <ExternalLinkIcon className="size-3" />
                  Open as file
                </button>
              )}
            </div>
            {codeOpen && (
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                <code>{entry.code.source}</code>
              </pre>
            )}
          </div>
        )}
        {entry.artifacts && entry.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {entry.artifacts.map((p) => (
              <button
                key={p}
                onClick={() => onOpenFile(p)}
                title={p}
                className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <FileIcon className="size-3 shrink-0" />
                <span className="truncate">{p.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
