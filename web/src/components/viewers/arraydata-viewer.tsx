"use client";
import { useEffect, useState } from "react";
import { sciSummaryUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

// ---------------------------------------------------------------------------
// Shapes (mirrors server/src/helpers/arrays_helper.py's JSON output)
// ---------------------------------------------------------------------------

interface TreeNode {
  path: string;
  type: "group" | "dataset";
  shape?: number[];
  dtype?: string;
  attrs?: Record<string, string>;
}
interface TreeSummary {
  format: string;
  kind: "tree";
  file_size: number;
  tree: TreeNode[];
  truncated: boolean;
}

interface ColumnInfo {
  name: string;
  dtype: string;
}
interface TableSummary {
  format: string;
  kind: "table";
  file_size: number;
  num_rows: number;
  num_columns: number;
  columns: ColumnInfo[];
  head: (string | null)[][];
}

interface ArrayInfo {
  name: string;
  shape: number[];
  dtype: string;
  min: number | null;
  max: number | null;
  mean: number | null;
  preview: (number | string)[];
}
interface NdarraySummary {
  format: string;
  kind: "ndarray";
  file_size: number;
  arrays: ArrayInfo[];
}

interface VariableInfo {
  name: string;
  dims: string[];
  shape: number[];
  dtype: string;
  attrs: Record<string, string>;
}
interface VariablesSummary {
  format: string;
  kind: "variables";
  file_size: number;
  dimensions: Record<string, number>;
  variables: VariableInfo[];
  num_variables: number;
  truncated: boolean;
  global_attrs: Record<string, string>;
}

type ArraysSummary = TreeSummary | TableSummary | NdarraySummary | VariablesSummary;

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}

function fmtNum(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// kind:"tree" (HDF5)
// ---------------------------------------------------------------------------

function TreeView({ summary }: { summary: TreeSummary }) {
  return (
    <div className="p-4">
      <ul className="space-y-0.5 font-mono text-xs">
        {summary.tree.map((node, i) => {
          const depth = node.path.split("/").filter(Boolean).length - 1;
          return (
            <li
              key={`${node.path}-${i}`}
              className="flex flex-wrap items-center gap-2 py-0.5"
              style={{ paddingLeft: `${Math.max(depth, 0) * 16}px` }}
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-sans font-medium uppercase ${
                  node.type === "group"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    : "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300"
                }`}
              >
                {node.type}
              </span>
              <span>{node.path || "/"}</span>
              {(node.shape || node.dtype) && (
                <span className="text-muted-foreground">
                  {node.shape ? `[${node.shape.join(", ")}]` : ""}
                  {node.shape && node.dtype ? " · " : ""}
                  {node.dtype ?? ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {summary.truncated && (
        <p className="mt-3 text-xs text-muted-foreground">
          Tree truncated — showing the first {summary.tree.length} nodes.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// kind:"table" (Parquet)
// ---------------------------------------------------------------------------

function TableView({ summary }: { summary: TableSummary }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b bg-background/95 px-4 py-2 text-xs">
        <span className="font-semibold">
          {summary.num_rows.toLocaleString()} rows · {summary.num_columns} cols
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {summary.columns.map((c) => (
                <th
                  key={c.name}
                  className="sticky top-0 border-b bg-muted px-3 py-1.5 text-left font-semibold whitespace-nowrap"
                >
                  {c.name}
                  <span className="ml-1 font-normal text-muted-foreground">{c.dtype}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.head.map((row, ri) => (
              <tr key={ri} className="border-b border-muted/50 hover:bg-muted/20">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-[280px] truncate px-3 py-1 text-muted-foreground"
                    title={cell ?? ""}
                  >
                    {cell ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// kind:"ndarray" (npy/npz)
// ---------------------------------------------------------------------------

function NdarrayView({ summary }: { summary: NdarraySummary }) {
  return (
    <div className="space-y-4 p-4">
      {summary.arrays.map((arr, i) => (
        <div key={`${arr.name}-${i}`} className="rounded-md border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{arr.name || "(unnamed)"}</span>
            <span className="text-xs text-muted-foreground">
              [{arr.shape.join(", ")}] · {arr.dtype}
            </span>
          </div>
          <div className="mb-2 flex flex-wrap gap-2">
            <Stat label="min" value={fmtNum(arr.min)} />
            <Stat label="max" value={fmtNum(arr.max)} />
            <Stat label="mean" value={fmtNum(arr.mean)} />
          </div>
          <div className="overflow-x-auto rounded bg-muted/20 p-2">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              preview{arr.preview.length > 0 ? ` (first ${arr.preview.length})` : ""}
            </p>
            <p className="whitespace-pre-wrap break-all font-mono text-[11px]">
              {arr.preview.length > 0 ? arr.preview.join(", ") : "(empty)"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// kind:"variables" (NetCDF)
// ---------------------------------------------------------------------------

function VariablesView({ summary }: { summary: VariablesSummary }) {
  const globalAttrEntries = Object.entries(summary.global_attrs ?? {});
  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Dimensions</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(summary.dimensions ?? {}).map(([name, size]) => (
            <span
              key={name}
              className="rounded-full border bg-muted/40 px-2.5 py-0.5 font-mono text-[11px]"
            >
              {name}: {size}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Variables ({summary.num_variables})
        </p>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border-b bg-muted px-3 py-1.5 text-left font-semibold">name</th>
                <th className="border-b bg-muted px-3 py-1.5 text-left font-semibold">dims</th>
                <th className="border-b bg-muted px-3 py-1.5 text-left font-semibold">shape</th>
                <th className="border-b bg-muted px-3 py-1.5 text-left font-semibold">dtype</th>
              </tr>
            </thead>
            <tbody>
              {summary.variables.map((v) => (
                <tr key={v.name} className="border-b border-muted/50 hover:bg-muted/20">
                  <td className="px-3 py-1 font-mono">{v.name}</td>
                  <td className="px-3 py-1 text-muted-foreground">{v.dims.join(", ")}</td>
                  <td className="px-3 py-1 text-muted-foreground">[{v.shape.join(", ")}]</td>
                  <td className="px-3 py-1 text-muted-foreground">{v.dtype}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {summary.truncated && (
          <p className="mt-1 text-xs text-muted-foreground">
            Truncated — showing {summary.variables.length} of {summary.num_variables} variables.
          </p>
        )}
      </div>

      {globalAttrEntries.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Global attributes</p>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {globalAttrEntries.map(([k, v]) => (
              <li key={k}>
                <span className="text-muted-foreground">{k}:</span> {v}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root viewer
// ---------------------------------------------------------------------------

export default function ArrayDataViewer({ path }: ViewerProps) {
  const [summary, setSummary] = useState<ArraysSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setError(null);
    fetch(sciSummaryUrl(path, "arrays"))
      .then(async (r) => {
        if (!r.ok) {
          const detail = (await r.json().catch(() => ({}))) as { detail?: string };
          throw new Error(detail.detail || `HTTP ${r.status}`);
        }
        return r.json() as Promise<ArraysSummary>;
      })
      .then((d) => {
        if (alive) setSummary(d);
      })
      .catch((e) => {
        if (alive) setError(String(e.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Array data preview failed</p>
        <p className="max-w-md text-xs">{error}</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs shrink-0">
        <span className="font-semibold">{summary.format}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtBytes(summary.file_size)}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {summary.kind === "tree" && <TreeView summary={summary} />}
        {summary.kind === "table" && <TableView summary={summary} />}
        {summary.kind === "ndarray" && <NdarrayView summary={summary} />}
        {summary.kind === "variables" && <VariablesView summary={summary} />}
        {!(["tree", "table", "ndarray", "variables"] as string[]).includes(summary.kind) && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Unrecognized array format{summary.kind ? ` (kind: ${summary.kind})` : ""}.
          </div>
        )}
      </div>
    </div>
  );
}
