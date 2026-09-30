"use client";
import { useEffect, useRef, useState } from "react";

export interface ArrayPlot {
  kind: "line" | "heatmap";
  values: (number | null)[][];
  x: number[];
  y: number[];
  shape: number[];
  slice: number;
  slices: number;
  leading_indices: number[];
  sampled: boolean;
  stats: { min: number | null; max: number | null; mean: number | null };
  missing: number;
}

export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en", { maximumSignificantDigits: 5 }).format(value);
}

/** Numeric axes (not category spacing), with gaps left in line series. */
export function NumericChart({ points, xLabel, yLabel, line = false }: {
  points: { x: number; y: number | null }[];
  xLabel: string;
  yLabel: string;
  line?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    let chart: { destroy(): void } | undefined;
    import("chart.js/auto").then(({ default: Chart }) => {
      if (!alive || !canvas.current) return;
      chart = new Chart(canvas.current, {
        type: "scatter",
        data: { datasets: [{ data: points, showLine: line, spanGaps: false, pointRadius: line ? 1.5 : 3,
          borderWidth: 1.5, borderColor: "#0891b2", backgroundColor: "#0891b2" }] },
        options: {
          animation: false, responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: "linear", title: { display: true, text: xLabel } },
            y: { type: "linear", title: { display: true, text: yLabel } },
          },
        },
      });
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; chart?.destroy(); };
  }, [points, xLabel, yLabel, line]);
  return <div className="h-64 min-w-0">
    {error ? <p className="p-4 text-sm text-muted-foreground">Chart unavailable. Values remain in the preview.</p>
      : <canvas ref={canvas} role="img" aria-label={`${yLabel} versus ${xLabel}`} />}
  </div>;
}

/** Nearest-neighbour cells preserve missing data and do not invent interpolation. */
function Heatmap({ plot }: { plot: ArrayPlot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState("");
  const { min, max } = plot.stats;
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || min === null || max === null) return;
    plot.values.forEach((row, y) => row.forEach((v, x) => {
      const t = v === null ? 0 : max === min ? 0.5 : (v - min) / (max - min);
      ctx.fillStyle = v === null ? "#64748b" : `rgb(${Math.round(20 + t * 230)}, ${Math.round(30 + t * 190)}, ${Math.round(100 - t * 60)})`;
      ctx.fillRect(x, y, 1, 1);
    }));
  }, [plot, min, max]);
  if (min === null) return <p className="p-4 text-sm text-muted-foreground">No finite values in this slice.</p>;
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">Columns {plot.x[0]}–{plot.x.at(-1)} · rows {plot.y[0]}–{plot.y.at(-1)} (zero-based, row 0 at top)</p>
    <canvas ref={canvas} width={plot.x.length} height={plot.y.length} role="img" aria-label="Array heatmap"
      className="h-auto max-h-96 w-full rounded border object-contain [image-rendering:pixelated]"
      style={{ aspectRatio: `${plot.x.length} / ${plot.y.length}` }}
      onMouseLeave={() => setHover("")}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        // object-contain can letterbox a wide or tall matrix.
        const scale = Math.min(rect.width / plot.x.length, rect.height / plot.y.length);
        const x = Math.floor((event.clientX - rect.left - (rect.width - scale * plot.x.length) / 2) / scale);
        const y = Math.floor((event.clientY - rect.top - (rect.height - scale * plot.y.length) / 2) / scale);
        setHover(x >= 0 && x < plot.x.length && y >= 0 && y < plot.y.length
          ? `Row ${plot.y[y]}, column ${plot.x[x]}: ${formatNumber(plot.values[y][x])}` : "");
      }} />
    <div className="flex items-center gap-2 text-xs tabular-nums">
      <span>{formatNumber(min)}</span>
      <div className="h-2 max-w-48 flex-1 rounded bg-gradient-to-r from-[#141e64] to-[#fadc28]" />
      <span>{formatNumber(max)}</span><span className="ml-2 text-muted-foreground">Missing: gray</span>
    </div>
    <p className="min-h-4 font-mono text-xs text-muted-foreground">{hover || "Hover over a cell to inspect its value."}</p>
  </div>;
}

export function ArrayVisualization({ plot }: { plot: ArrayPlot }) {
  return <div className="space-y-3 rounded-lg border bg-background p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{plot.kind === "heatmap" ? "Heatmap" : "Line plot"}</span>
      <span className="text-xs text-muted-foreground">{plot.sampled ? "Strided sample" : "Full slice"} · {plot.x.length * plot.y.length} values</span>
    </div>
    {plot.kind === "heatmap" ? <Heatmap plot={plot} /> : <NumericChart
      points={plot.x.map((x, i) => ({ x, y: plot.values[0][i] }))} xLabel="Index (zero-based)" yLabel="Value" line />}
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      <span>Min <strong className="font-mono text-foreground">{formatNumber(plot.stats.min)}</strong></span>
      <span>Max <strong className="font-mono text-foreground">{formatNumber(plot.stats.max)}</strong></span>
      <span>Mean <strong className="font-mono text-foreground">{formatNumber(plot.stats.mean)}</strong></span>
      <span>{plot.missing} missing / nonfinite</span>
    </div>
    <p className="text-xs text-muted-foreground">Statistics and color range describe the displayed {plot.sampled ? "sample" : "slice"} only.
      {plot.leading_indices.length > 0 && ` Leading dimension indices: [${plot.leading_indices.join(", ")}].`}</p>
  </div>;
}
