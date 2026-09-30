"use client";

import { XIcon } from "lucide-react";
import { memo } from "react";
import { diagnosticMatchesFile, parseFileLineDiagnostic } from "@/lib/latex/diagnostics";

export type LogFilter = "all" | "problems";

const PROBLEM_RE = /^(!|.*:\d+:|LaTeX Warning|Overfull|Underfull|Package \S+ Warning)|not found|failed|timed out|cancelled|error/i;

export const LogPanel = memo(function LogPanel({
  log,
  open,
  onClose,
  filter,
  onFilterChange,
  fileName,
  compileTarget,
  errors = [],
  stale = false,
  onJump,
  onFixError,
}: {
  log: string;
  open: boolean;
  onClose: () => void;
  filter: LogFilter;
  onFilterChange: (f: LogFilter) => void;
  /** Full sandbox path, so same-named chapters are not confused. */
  fileName?: string;
  compileTarget?: string;
  errors?: string[];
  stale?: boolean;
  onJump?: (line: number) => void;
  onFixError?: (line: number, message: string) => void;
}) {
  if (!open) return null;
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
          aria-label="Close compilation log"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {stale && <p className="px-3 pt-2 text-[11px] text-amber-700 dark:text-amber-300">Source changed since compilation. Recompile to update error locations.</p>}
      {errors.length > 0 && (
        <ul className="space-y-1 px-3 pt-2 text-[11px] text-red-600 dark:text-red-400">
          {errors.map((error, i) => <li key={i}>{error}</li>)}
        </ul>
      )}
      <pre className="whitespace-pre-wrap break-words p-3 text-[11px] font-mono leading-relaxed text-muted-foreground">
        {shown.map((line, i) => {
          const diagnostic = parseFileLineDiagnostic(line);
          const fixable = diagnostic !== null && !!fileName && diagnosticMatchesFile(diagnostic.file, fileName, compileTarget);
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
              {onJump && diagnostic && fixable && !stale ? (
                <button className="text-left underline decoration-dotted underline-offset-2 hover:decoration-solid" title={`Go to line ${diagnostic.line}`} onClick={() => onJump(diagnostic.line)}>{line}</button>
              ) : line}
              {onFixError && diagnostic && fixable && !stale && (
                <button
                  onClick={() => onFixError(diagnostic.line, diagnostic.message)}
                  className="ml-2 rounded bg-violet-600/90 px-1.5 text-[10px] text-white hover:bg-violet-600"
                >
                  Fix with AI
                </button>
              )}
              {"\n"}
            </span>
          );
        })}
        {filter === "problems" && shown.length === 0 && errors.length === 0 && "No problems found in log.\n"}
      </pre>
    </div>
  );
});
