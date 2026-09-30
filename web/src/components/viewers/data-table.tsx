"use client";
import { useMemo, useState } from "react";
import { NumericChart } from "./data-plots";

export interface TableSummary {
  format: string;
  kind: "table";
  file_size: number;
  num_rows: number | null;
  num_columns: number;
  columns: { name: string; dtype: string }[];
  head: (string | number | boolean | null)[][];
  rows_truncated?: boolean;
  columns_truncated?: boolean;
  collections?: string[];
  selected?: string;
  collections_truncated?: boolean;
  cell_limit?: number;
  note?: string;
}

/** Empty cells and booleans are not quantitative measurements. */
export function numericCell(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && (!value.trim() || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) return null;
  return n;
}

export default function DataTable({ summary }: { summary: TableSummary }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);
  const [view, setView] = useState<"table" | "plot">("table");
  const numericColumns = summary.columns.flatMap((column, i) =>
    summary.head.some(row => numericCell(row[i]) !== null) ? [{ name: column.name, index: i }] : []);
  const [x, setX] = useState(-1);
  const [y, setY] = useState(numericColumns[0]?.index ?? -1);
  const rows = useMemo(() => {
    const result = summary.head.map((row, index) => ({ row, index })).filter(({ row }) =>
      row.some(cell => String(cell ?? "").toLowerCase().includes(search.toLowerCase())));
    if (sort) result.sort((a, b) => {
      const av = a.row[sort.column], bv = b.row[sort.column];
      const an = numericCell(av), bn = numericCell(bv);
      const delta = an !== null && bn !== null ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""));
      return sort.desc ? -delta : delta;
    });
    return result;
  }, [summary.head, search, sort]);
  const points = useMemo(() => summary.head.flatMap((row, index) => {
    const px = x === -1 ? index + 1 : numericCell(row[x]), py = numericCell(row[y]);
    return px === null || py === null ? [] : [{ x: px, y: py }];
  }), [summary.head, x, y]);
  const limited = summary.rows_truncated || (summary.num_rows !== null && summary.num_rows > summary.head.length);
  return <div className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        {summary.num_rows === null ? `${summary.head.length} preview rows · total not scanned` : `${summary.num_rows.toLocaleString()} rows`}
        {` · ${summary.num_columns} columns`}
      </p>
      <div className="flex gap-1 rounded-md border p-0.5 text-xs">
        <button className={`rounded px-3 py-1 ${view === "table" ? "bg-muted" : ""}`} onClick={() => setView("table")} aria-pressed={view === "table"}>Table</button>
        <button className={`rounded px-3 py-1 disabled:opacity-40 ${view === "plot" ? "bg-muted" : ""}`} disabled={!numericColumns.length}
          onClick={() => setView("plot")} aria-pressed={view === "plot"}>Plot</button>
      </div>
    </div>
    {(limited || summary.columns_truncated) && <p className="text-xs text-muted-foreground">
      Showing the first {summary.head.length} rows and {summary.columns.length} columns. Search, sorting, and plots use this preview only.
    </p>}
    {summary.note && <p className="text-xs text-muted-foreground">{summary.note}</p>}
    {view === "plot" ? <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">X axis<select className="max-w-52 rounded border bg-background px-2 py-1" value={x} onChange={e => setX(Number(e.target.value))}>
          <option value={-1}>Row number</option>{numericColumns.map(col => <option key={col.index} value={col.index}>{col.name}</option>)}
        </select></label>
        <label className="flex items-center gap-2">Y axis<select className="max-w-52 rounded border bg-background px-2 py-1" value={y} onChange={e => setY(Number(e.target.value))}>
          {numericColumns.map(col => <option key={col.index} value={col.index}>{col.name}</option>)}
        </select></label>
      </div>
      <NumericChart points={points} xLabel={x === -1 ? "Row number" : summary.columns[x]?.name ?? "X"} yLabel={summary.columns[y]?.name ?? "Y"} />
      <p className="text-xs text-muted-foreground">{points.length} numeric pairs from {summary.head.length} preview rows. Missing and nonnumeric pairs are omitted. Table search and sorting do not change the plot.</p>
    </div> : <>
      <input aria-label="Search preview rows" placeholder="Search preview rows…" value={search} onChange={e => setSearch(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-xs" />
      <div className="max-h-[32rem] overflow-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead><tr>{summary.columns.map((col, i) => <th key={i} aria-sort={sort?.column === i ? (sort.desc ? "descending" : "ascending") : "none"}
            className="sticky top-0 whitespace-nowrap border-b bg-muted text-left">
            <button className="w-full px-3 py-2 text-left font-medium" onClick={() => setSort({ column: i, desc: sort?.column === i && !sort.desc })}>
              {col.name} {sort?.column === i ? (sort.desc ? "↓" : "↑") : ""}<span className="ml-1 font-normal text-muted-foreground">{col.dtype}</span>
            </button>
          </th>)}</tr></thead>
          <tbody>{rows.map(({ row, index }) => <tr key={index} className="border-b border-muted/50 hover:bg-muted/20">
            {row.map((value, i) => <td key={i} className="max-w-72 truncate px-3 py-1.5 font-mono" title={String(value ?? "")}>
              {value === null ? <span className="text-muted-foreground">—</span> : String(value)}
            </td>)}
          </tr>)}</tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-xs text-muted-foreground">{summary.head.length ? "No matching preview rows." : "No data rows in this table."}</p>}
      </div>
      {summary.cell_limit && <p className="text-[11px] text-muted-foreground">Long cell values are limited to {summary.cell_limit} characters.</p>}
    </>}
  </div>;
}
