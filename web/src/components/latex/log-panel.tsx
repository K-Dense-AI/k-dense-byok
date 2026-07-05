"use client";

import { XIcon } from "lucide-react";

export type LogFilter = "all" | "problems";

const PROBLEM_RE = /^(!|.*:\d+:|LaTeX Warning|Overfull|Underfull|Package \w+ Warning)/;

export function LogPanel({
  log,
  open,
  onClose,
  filter,
  onFilterChange,
  onFixError,
}: {
  log: string;
  open: boolean;
  onClose: () => void;
  filter: LogFilter;
  onFilterChange: (f: LogFilter) => void;
  onFixError?: (line: number, message: string) => void;
}) {
  if (!open || !log) return null;
  const lines = log.split("\n");
  const shown = filter === "problems" ? lines.filter((l) => PROBLEM_RE.test(l)) : lines;
  return (
    <div className="shrink-0 max-h-48 overflow-auto border-t bg-muted/10">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/40 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Compilation Log
        </span>
        <div className="flex overflow-hidden rounded border text-[10px]">
          {(["all", "problems"] as const).map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              className={
                filter === f
                  ? "bg-muted px-2 py-0.5 font-medium text-foreground"
                  : "px-2 py-0.5 text-muted-foreground hover:text-foreground"
              }
            >
              {f === "all" ? "All" : "Problems"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words p-3 text-[11px] font-mono leading-relaxed text-muted-foreground">
        {shown.map((line, i) => {
          const errMatch = /^(?:\.\/)?\S+?:(\d+):\s*(.+)$/.exec(line);
          return (
            <span
              key={i}
              className={
                line.startsWith("!") || /:\d+:/.test(line)
                  ? "text-red-600 dark:text-red-400 font-medium"
                  : /Warning|Overfull|Underfull/.test(line)
                    ? "text-amber-600 dark:text-amber-400"
                    : ""
              }
            >
              {line}
              {onFixError && errMatch && (
                <button
                  onClick={() => onFixError(parseInt(errMatch[1], 10), errMatch[2])}
                  className="ml-2 rounded bg-violet-600/90 px-1.5 text-[10px] text-white hover:bg-violet-600"
                >
                  Fix with AI
                </button>
              )}
              {"\n"}
            </span>
          );
        })}
        {filter === "problems" && shown.length === 0 && "No problems found in log.\n"}
      </pre>
    </div>
  );
}
