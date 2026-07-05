"use client";

import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ItalicIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  SpellCheckIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type Engine = "pdflatex" | "xelatex" | "lualatex";

export const ENGINES: { id: Engine; label: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX" },
  { id: "xelatex", label: "XeLaTeX" },
  { id: "lualatex", label: "LuaLaTeX" },
];

export type SnippetAction =
  | { kind: "wrap"; before: string; after: string }
  | { kind: "block"; text: string };

const BLOCK_SNIPPETS: { label: string; text: string }[] = [
  {
    label: "Figure",
    text: "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n",
  },
  {
    label: "Table",
    text: "\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{lcc}\n    \\toprule\n     &  &  \\\\\n    \\midrule\n     &  &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n",
  },
  { label: "Equation", text: "\\begin{equation}\n  \n  \\label{eq:}\n\\end{equation}\n" },
  { label: "Itemize", text: "\\begin{itemize}\n  \\item \n\\end{itemize}\n" },
  { label: "Enumerate", text: "\\begin{enumerate}\n  \\item \n\\end{enumerate}\n" },
];

export interface LatexToolbarProps {
  compiling: boolean;
  saving: boolean;
  saved: boolean;
  isDirty: boolean;
  engine: Engine;
  onEngineChange: (e: Engine) => void;
  onCompile: () => void;
  onSave: () => void;
  onDiscard: () => void;
  errorCount: number;
  warningCount: number;
  hasPdf: boolean;
  hasLog: boolean;
  logOpen: boolean;
  onToggleLog: () => void;
  autoCompile: boolean;
  onToggleAutoCompile: () => void;
  wordCount: number;
  modKey: string;
  onSnippet: (action: SnippetAction) => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  spellcheck: boolean;
  onToggleSpellcheck: () => void;
}

export function LatexToolbar(p: LatexToolbarProps) {
  const [insertOpen, setInsertOpen] = useState(false);
  const insertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!insertOpen) return;
    const close = (e: MouseEvent) => {
      if (!insertRef.current?.contains(e.target as Node)) setInsertOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [insertOpen]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
      <button
        onClick={p.onCompile}
        disabled={p.compiling}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
          p.compiling
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-600 text-white hover:bg-emerald-700",
        )}
      >
        {p.compiling ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
        {p.compiling ? "Compiling…" : "Compile"}
      </button>

      <select
        value={p.engine}
        onChange={(e) => p.onEngineChange(e.target.value as Engine)}
        className="rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none"
      >
        {ENGINES.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>

      <label
        className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground"
        title="Compile automatically after each save"
      >
        <input
          type="checkbox"
          checked={p.autoCompile}
          onChange={p.onToggleAutoCompile}
          className="size-3"
        />
        auto
      </label>

      <div className="h-4 w-px bg-border" />

      {/* Quick inserts */}
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "\\textbf{", after: "}" })}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Bold"
      >
        <BoldIcon className="size-3.5" />
      </button>
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "\\emph{", after: "}" })}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Emphasis"
      >
        <ItalicIcon className="size-3.5" />
      </button>
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "$", after: "$" })}
        className="rounded p-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Inline math"
      >
        $
      </button>
      <div ref={insertRef} className="relative">
        <button
          onClick={() => setInsertOpen((v) => !v)}
          className="flex items-center gap-0.5 rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Insert block"
        >
          <PlusIcon className="size-3.5" />
          <ChevronDownIcon className="size-3" />
        </button>
        {insertOpen && (
          <div className="absolute left-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border bg-background shadow-lg">
            {BLOCK_SNIPPETS.map((s) => (
              <button
                key={s.label}
                onClick={() => {
                  p.onSnippet({ kind: "block", text: s.text });
                  setInsertOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={p.onToggleOutline}
        className={cn(
          "rounded p-1 transition-colors hover:bg-muted",
          p.outlineOpen ? "text-foreground" : "text-muted-foreground",
        )}
        title="Toggle outline"
      >
        <ListTreeIcon className="size-3.5" />
      </button>

      <button
        onClick={p.onToggleSpellcheck}
        className={cn(
          "rounded p-1 transition-colors hover:bg-muted",
          p.spellcheck ? "text-foreground" : "text-muted-foreground",
        )}
        title="Toggle spell check"
      >
        <SpellCheckIcon className="size-3.5" />
      </button>

      {/* Status */}
      {(p.errorCount > 0 || p.warningCount > 0) && !p.compiling && (
        <button
          onClick={p.onToggleLog}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            p.errorCount > 0
              ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              : "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40",
          )}
        >
          <AlertTriangleIcon className="size-3.5" />
          {p.errorCount > 0
            ? `${p.errorCount} error${p.errorCount !== 1 ? "s" : ""}`
            : `${p.warningCount} warning${p.warningCount !== 1 ? "s" : ""}`}
        </button>
      )}
      {p.hasPdf && p.errorCount === 0 && !p.compiling && (
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-3.5" /> PDF ready
        </span>
      )}

      <div className="flex-1" />

      <span className="text-[10px] tabular-nums text-muted-foreground/70">
        {p.wordCount.toLocaleString()} words
      </span>

      {p.hasLog && (
        <button
          onClick={p.onToggleLog}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          {p.logOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronUpIcon className="size-3.5" />}
          Log
        </button>
      )}

      <div className="h-4 w-px bg-border" />

      <div
        className={cn(
          "size-2 rounded-full transition-colors",
          p.isDirty ? "bg-amber-500" : "bg-muted-foreground/30",
        )}
      />
      <span className="font-mono text-[10px] text-muted-foreground/60">
        {p.modKey}S save · {p.modKey}↵ compile
      </span>

      <button
        onClick={p.onSave}
        disabled={!p.isDirty || p.saving}
        className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {p.saved ? <CheckIcon className="size-3" /> : null}
        {p.saving ? "Saving…" : p.saved ? "Saved!" : "Save"}
      </button>

      <button
        onClick={p.onDiscard}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Close
      </button>
    </div>
  );
}
