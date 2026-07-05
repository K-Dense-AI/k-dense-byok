"use client";
import { useMemo } from "react";
import { parseAlignment, type AlignRow } from "@/lib/alignment";
import type { ViewerProps } from "@/lib/viewers/registry";

// Cap what we render so a pathological/huge alignment doesn't hang the DOM —
// beyond these, we render a prefix and note the truncation.
const MAX_ROWS = 200;
const MAX_COLS = 1000;

type SeqType = "dna" | "rna" | "protein";

const GAP_CLASS = "text-muted-foreground/30";

// Compact color maps in the spirit of the FASTA viewer's residue coloring
// (file-preview-panel.tsx) — kept local so the alignment viewer has no
// dependency on that (much larger) file.
const DNA_COLOR: Record<string, string> = {
  A: "text-emerald-600",
  T: "text-rose-500",
  C: "text-blue-500",
  G: "text-amber-500",
  U: "text-purple-500",
  N: "text-muted-foreground",
};

const AA_COLOR: Record<string, string> = {
  // Hydrophobic
  A: "text-amber-600", V: "text-amber-600", I: "text-amber-600", L: "text-amber-600",
  M: "text-amber-600", F: "text-orange-600", W: "text-orange-600", P: "text-amber-500",
  // Polar uncharged
  S: "text-emerald-600", T: "text-emerald-600", C: "text-yellow-600",
  Y: "text-emerald-700", N: "text-emerald-600", Q: "text-emerald-600", G: "text-slate-400",
  // Negative
  D: "text-red-500", E: "text-red-500",
  // Positive
  K: "text-blue-500", R: "text-blue-600", H: "text-blue-400",
  "*": "text-muted-foreground/40",
};

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf(".");
  return idx === -1 ? "" : lower.slice(idx + 1);
}

function detectType(rows: AlignRow[]): SeqType {
  const sample = rows
    .slice(0, 5)
    .map((r) => r.seq.slice(0, 200))
    .join("")
    .toUpperCase()
    .replace(/[-.\sNX]/g, "");
  if (sample.length === 0) return "protein";
  if (/^[ACGT]+$/.test(sample)) return "dna";
  if (/^[ACGU]+$/.test(sample)) return "rna";
  return "protein";
}

function colorFor(ch: string, type: SeqType): string {
  const up = ch.toUpperCase();
  if (up === "-" || up === "." || up === "~") return GAP_CLASS;
  const map = type === "protein" ? AA_COLOR : DNA_COLOR;
  return map[up] ?? "text-foreground";
}

type ParseResult =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; rows: AlignRow[] };

export default function AlignmentViewer({ content, name }: ViewerProps) {
  const result = useMemo<ParseResult>(() => {
    if (content == null) return { status: "loading" };
    try {
      const rows = parseAlignment(content, extOf(name));
      return { status: "ok", rows };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }, [content, name]);

  if (result.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Couldn&apos;t parse this alignment</p>
        <p className="max-w-md text-xs">{result.message}</p>
      </div>
    );
  }

  const { rows } = result;
  const nCols = rows[0]?.seq.length ?? 0;
  const type = detectType(rows);

  const visibleRows = rows.slice(0, MAX_ROWS);
  const displayCols = Math.min(nCols, MAX_COLS);
  const rowsTruncated = rows.length > MAX_ROWS;
  const colsTruncated = nCols > MAX_COLS;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur text-xs">
        <span className="font-semibold">
          {rows.length.toLocaleString()} sequence{rows.length !== 1 ? "s" : ""}
        </span>
        <span className="text-muted-foreground">×</span>
        <span className="text-muted-foreground">{nCols.toLocaleString()} columns</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {type}
        </span>
      </div>

      {(rowsTruncated || colsTruncated) && (
        <p className="px-4 pt-2 text-xs text-muted-foreground">
          Showing the first {visibleRows.length.toLocaleString()} of {rows.length.toLocaleString()}{" "}
          sequences and the first {displayCols.toLocaleString()} of {nCols.toLocaleString()} columns.
        </p>
      )}

      <div className="p-3">
        <div className="inline-block min-w-full font-mono text-xs leading-relaxed">
          {visibleRows.map((row) => (
            <div key={row.id} className="flex whitespace-pre">
              <span
                className="sticky left-0 z-[1] inline-block w-32 shrink-0 truncate bg-background pr-2 font-semibold"
                title={row.id}
              >
                {row.id}
              </span>
              <span>
                {row.seq
                  .slice(0, displayCols)
                  .split("")
                  .map((ch, i) => (
                    <span key={i} className={colorFor(ch, type)}>
                      {ch}
                    </span>
                  ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
