"use client";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getActiveProjectId } from "@/lib/projects";
import { renderOffice } from "@/lib/office-render";
import type { OfficeText } from "@/lib/office";
import type { ViewerProps } from "@/lib/viewers/registry";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
const ArrayDataViewer = lazy(() => import("./arraydata-viewer"));
const button = "rounded border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed";

export default function OfficeViewer({ path, name, projectId = getActiveProjectId() }: ViewerProps) {
  const [model, setModel] = useState<OfficeText | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const spreadsheet = /\.xlsx$/i.test(path);
  const reload = useCallback(() => setGeneration(n => n + 1), []);
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key !== "kady:office-saved" || !e.newValue) return;
      try { const data = JSON.parse(e.newValue); if (data.projectId === projectId && data.path === path) reload(); } catch {}
    };
    window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
  }, [path, projectId, reload]);
  useEffect(() => {
    if (spreadsheet) return;
    const cancel = new AbortController(); setError(""); setModel(null);
    void apiFetch(`/sandbox/office?path=${encodeURIComponent(path)}`, { signal: cancel.signal }, projectId).then(async res => {
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || "Could not preview document");
      if (!cancel.signal.aborted) setModel(data);
    }).catch(e => { if (!cancel.signal.aborted) setError(String(e.message)); });
    return () => cancel.abort();
  }, [path, projectId, generation, spreadsheet]);
  const url = `/office?${new URLSearchParams({ path, project: projectId })}`;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <span className="flex-1 text-xs text-muted-foreground">{spreadsheet ? "Workbook preview" : "Document preview"}</span>
      <button className={button} onClick={reload} aria-label="Refresh Office preview"><RefreshCwIcon className="size-3.5" /></button>
      <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Edit in Office <ExternalLinkIcon className="size-3" /></a>
    </div>
    {error && <div role="alert" className="p-4 text-sm text-destructive">{error} <button className={button} onClick={reload}>Retry</button></div>}
    {spreadsheet ? <Suspense fallback={<p className="p-4 text-xs">Loading workbook…</p>}><ArrayDataViewer key={generation} path={path} name={name} projectId={projectId} content={null} /></Suspense> : model ? <OfficePreview model={model} /> : !error && <p className="p-4 text-xs text-muted-foreground">Loading document…</p>}
  </div>;
}

function OfficePreview({ model }: { model: OfficeText }) {
  const [preview, setPreview] = useState<{ html?: string; pageWidth?: number; slides?: string[] } | null>(null);
  const [error, setError] = useState("");
  const [slide, setSlide] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(816);
  useEffect(() => {
    if (!host.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [preview]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError(""); setSlide(0);
    void renderOffice(model).then(result => { if (!cancelled) setPreview(result); }, e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [model]);
  if (error) return <div className="overflow-auto p-4"><p role="alert" className="mb-3 text-xs text-destructive">Visual preview unavailable: {error}. Text contents are shown below.</p>{model.groups.map((g, i) => <section key={i}><h3 className="font-medium">{g.label}</h3>{g.paragraphs.map((p, j) => <p className="my-2 whitespace-pre-wrap" key={j}>{p.runs.map(r => r.text).join("")}</p>)}</section>)}</div>;
  if (!preview) return <div className="p-4 text-xs text-muted-foreground" role="status">Rendering preview…</div>;
  if (preview.html) {
    const zoom = Math.max(0.1, Math.min(1, (width - 32) / (preview.pageWidth ?? 816)));
    const html = preview.html.replace("<head>", `<head><style>:root{--office-zoom:${zoom}}</style>`);
    return <div ref={host} className="min-h-0 flex-1"><iframe title="Word document preview" sandbox="" referrerPolicy="no-referrer" srcDoc={html} className="h-full w-full border-0 bg-white" /></div>;
  }
  const slides = preview.slides ?? [];
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-center gap-3 border-b p-2">
      <button className={button} disabled={slide === 0} onClick={() => setSlide(i => i - 1)}>Previous slide</button>
      <span className="text-xs">Slide {slides.length ? slide + 1 : 0} of {slides.length}</span>
      <button className={button} disabled={slide >= slides.length - 1} onClick={() => setSlide(i => i + 1)}>Next slide</button>
    </div>
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/30 p-3">{slides[slide] && <img src={slides[slide]} alt={`Slide ${slide + 1}`} className="w-full bg-white shadow" />}</div>
  </div>;
}

