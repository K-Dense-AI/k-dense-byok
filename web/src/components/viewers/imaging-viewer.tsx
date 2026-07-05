"use client";
import { useEffect, useState } from "react";
import { sciRenderUrl, sciSummaryUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

// ---------------------------------------------------------------------------
// Shapes (mirrors server/src/helpers/imaging_helper.py's `summarize` JSON)
// ---------------------------------------------------------------------------

interface AxisInfo {
  name: string;
  size: number;
}

interface ImagingSummary {
  format: string;
  file_size: number;
  shape: number[];
  dtype: string;
  axes: AxisInfo[];
  default_axis: string;
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

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

function fmtMetaValue(v: unknown): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Root viewer
// ---------------------------------------------------------------------------

export default function ImagingViewer({ path }: ViewerProps) {
  const [summary, setSummary] = useState<ImagingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAxis, setActiveAxis] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setError(null);
    setActiveAxis(null);
    setIndex(0);
    fetch(sciSummaryUrl(path, "imaging"))
      .then(async (r) => {
        if (!r.ok) {
          const detail = (await r.json().catch(() => ({}))) as { detail?: string };
          throw new Error(detail.detail || `HTTP ${r.status}`);
        }
        return r.json() as Promise<ImagingSummary>;
      })
      .then((d) => {
        if (!alive) return;
        setSummary(d);
        const axis = d.default_axis ?? d.axes[0]?.name ?? null;
        setActiveAxis(axis);
        const size = d.axes.find((a) => a.name === axis)?.size ?? d.axes[0]?.size ?? 1;
        setIndex(Math.floor(size / 2));
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
        <p className="font-medium">Image preview failed</p>
        <p className="max-w-md text-xs">{error}</p>
      </div>
    );
  }

  if (!summary || activeAxis == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  const axisInfo = summary.axes.find((a) => a.name === activeAxis) ?? summary.axes[0];
  const maxIndex = Math.max(axisInfo.size - 1, 0);
  const metaEntries = Object.entries(summary.meta ?? {});

  function handleAxisChange(nextAxis: string) {
    if (!summary) return;
    setActiveAxis(nextAxis);
    const size = summary.axes.find((a) => a.name === nextAxis)?.size ?? 1;
    setIndex(Math.floor(size / 2));
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs shrink-0">
        <span className="font-semibold">{summary.format}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">[{summary.shape.join(", ")}]</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{summary.dtype}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtBytes(summary.file_size)}</span>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row">
        <div className="flex flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {summary.axes.length > 1 && (
              <div className="flex items-center gap-2">
                <label htmlFor="imaging-axis-select" className="text-xs font-medium text-muted-foreground">
                  Axis
                </label>
                <select
                  id="imaging-axis-select"
                  className="rounded-md border bg-background px-2 py-1 text-xs"
                  value={activeAxis}
                  onChange={(e) => handleAxisChange(e.target.value)}
                >
                  {summary.axes.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-1 items-center gap-2">
              <label htmlFor="imaging-slice-slider" className="text-xs font-medium text-muted-foreground">
                Slice
              </label>
              <input
                id="imaging-slice-slider"
                type="range"
                min={0}
                max={maxIndex}
                step={1}
                value={index}
                onChange={(e) => setIndex(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                {index} / {maxIndex}
              </span>
            </div>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-auto rounded-md border bg-muted/10 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sciRenderUrl(path, "imaging", index, activeAxis)}
              alt={`${summary.format} slice ${index} (${activeAxis})`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </div>

        {metaEntries.length > 0 && (
          <div className="w-full shrink-0 lg:w-64">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Metadata</p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {metaEntries.map(([k, v]) => (
                    <tr key={k} className="border-b border-muted/50 last:border-b-0">
                      <td className="px-2 py-1 font-mono text-muted-foreground">{k}</td>
                      <td className="px-2 py-1 font-mono">{fmtMetaValue(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
