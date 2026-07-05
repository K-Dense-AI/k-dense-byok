"use client";
import { useEffect, useRef, useState } from "react";
import { sciSummaryUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

interface SpectrumEntry {
  id: string;
  ms_level: number | null;
  rt: number | null;
  precursor_mz: number | null;
  mz: number[];
  intensity: number[];
}

interface MassSpecSummary {
  format: string;
  mode: string;
  title: string;
  n_spectra: number;
  x_label: string;
  y_label: string;
  chromatogram: { x: number[]; y: number[] } | null;
  spectra: SpectrumEntry[];
  curve: { x: number[]; y: number[] } | null;
}

type ChartInstance = { destroy(): void };
// Minimal shape of the chart.js constructor we rely on — avoids pulling the
// full chart.js types into this file while still typing the dynamic import.
type ChartCtor = new (
  ctx: HTMLCanvasElement,
  config: Record<string, unknown>,
) => ChartInstance;

function lineConfig(x: number[], y: number[], xLabel: string, yLabel: string) {
  return {
    type: "line",
    data: {
      labels: x,
      datasets: [
        {
          data: y,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.1)",
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: xLabel } },
        y: { title: { display: true, text: yLabel } },
      },
    },
  };
}

function barConfig(x: number[], y: number[], xLabel: string, yLabel: string) {
  return {
    type: "bar",
    data: {
      labels: x.map((v) => v.toFixed(2)),
      datasets: [
        {
          data: y,
          backgroundColor: "#2563eb",
          barThickness: 2,
          categoryPercentage: 1,
          barPercentage: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: xLabel }, ticks: { autoSkip: true, maxTicksLimit: 12 } },
        y: { title: { display: true, text: yLabel }, beginAtZero: true },
      },
    },
  };
}

/** Renders one chart.js instance into a canvas, tearing it down on
 *  cleanup/redraw so canvases don't leak across re-renders. */
function SpectrumChart({ config }: { config: Record<string, unknown> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chartError, setChartError] = useState(false);

  useEffect(() => {
    let alive = true;
    let chart: ChartInstance | undefined;
    setChartError(false);
    import("chart.js/auto")
      .then((mod) => {
        if (!alive || !canvasRef.current) return;
        const Chart = mod.default as unknown as ChartCtor;
        chart = new Chart(canvasRef.current, config);
      })
      .catch(() => {
        if (alive) setChartError(true);
      });
    return () => {
      alive = false;
      chart?.destroy();
    };
  }, [config]);

  if (chartError) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        (chart unavailable)
      </div>
    );
  }
  return <canvas ref={canvasRef} />;
}

export default function SpectrumViewer({ path }: ViewerProps) {
  const [summary, setSummary] = useState<MassSpecSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setError(null);
    setSelectedId(null);
    fetch(sciSummaryUrl(path, "massspec"))
      .then(async (r) => {
        if (!r.ok) {
          const detail = (await r.json().catch(() => ({}))) as { detail?: string };
          throw new Error(detail.detail || `HTTP ${r.status}`);
        }
        return r.json() as Promise<MassSpecSummary>;
      })
      .then((d) => {
        if (!alive) return;
        setSummary(d);
        setSelectedId(d.spectra[0]?.id ?? null);
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
        <p className="font-medium">Spectrum preview failed</p>
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

  const selected = summary.spectra.find((s) => s.id === selectedId) ?? summary.spectra[0] ?? null;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
        <span className="font-semibold">
          {summary.n_spectra} spectra · {summary.format}
        </span>
        {summary.title && <span className="text-muted-foreground">{summary.title}</span>}
      </div>

      <div className="flex-1 space-y-4 p-4">
        {summary.chromatogram && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Total ion chromatogram
            </p>
            <div className="h-56">
              <SpectrumChart
                config={lineConfig(
                  summary.chromatogram.x,
                  summary.chromatogram.y,
                  "retention time",
                  "intensity",
                )}
              />
            </div>
          </div>
        )}

        {summary.spectra.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="spectrum-select" className="text-xs font-medium text-muted-foreground">
                Spectrum
              </label>
              <select
                id="spectrum-select"
                className="rounded-md border bg-background px-2 py-1 text-xs"
                value={selected?.id ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {summary.spectra.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
              {selected?.precursor_mz != null && (
                <span className="text-xs text-muted-foreground">
                  precursor m/z {selected.precursor_mz.toFixed(4)}
                </span>
              )}
              {selected?.rt != null && (
                <span className="text-xs text-muted-foreground">rt {selected.rt.toFixed(2)}</span>
              )}
            </div>
            {selected && (
              <div className="h-64">
                <SpectrumChart
                  key={selected.id}
                  config={barConfig(
                    selected.mz,
                    selected.intensity,
                    summary.x_label,
                    summary.y_label,
                  )}
                />
              </div>
            )}
          </div>
        )}

        {summary.curve && (
          <div>
            <div className="h-64">
              <SpectrumChart
                config={lineConfig(
                  summary.curve.x,
                  summary.curve.y,
                  summary.x_label,
                  summary.y_label,
                )}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
