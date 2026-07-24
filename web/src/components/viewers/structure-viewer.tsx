"use client";
import { useEffect, useRef, useState } from "react";
import { rawFileUrl, sciSummaryUrl } from "@/lib/use-sandbox";
import { fetchSciJson, isAbortError, SCI_FETCH_TIMEOUT_MS, SciTimeoutError } from "@/lib/sci-fetch";
import type { ViewerProps } from "@/lib/viewers/registry";

/**
 * 3Dmol parses the whole structure into JS objects on the main thread, so a
 * multi-hundred-megabyte trajectory freezes the tab outright. Past this size
 * the user gets an explicit opt-in instead.
 */
const MAX_AUTOLOAD_BYTES = 40 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

interface StructSummary {
  format: string; num_atoms: number; num_chains: number; chains: string[];
  num_residues: number; num_ligands: number; ligands: string[];
  resolution: number | null; title: string;
}

function fmtForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "cif" || ext === "mmcif") return "cif";
  if (ext === "xyz") return "xyz";
  return "pdb"; // pdb/ent/gro/pdbqt handled as pdb-ish by 3Dmol
}

export default function StructureViewer({ path, name, projectId }: ViewerProps) {
  const [summary, setSummary] = useState<StructSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [viewerErr, setViewerErr] = useState<string | null>(null);
  const [oversizeBytes, setOversizeBytes] = useState<number | null>(null);
  const [loadAnyway, setLoadAnyway] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setSummary(null); setSummaryErr(null);
    fetchSciJson<StructSummary>(sciSummaryUrl(path, "structure", projectId), { signal: ac.signal })
      .then((d) => { if (!ac.signal.aborted) setSummary(d); })
      .catch((e) => { if (!isAbortError(e)) setSummaryErr(String(e.message ?? e)); });
    return () => ac.abort();
  }, [path, projectId]);

  useEffect(() => {
    setLoadAnyway(false);
    setOversizeBytes(null);
  }, [path]);

  useEffect(() => {
    setViewerErr(null);
    if (!mountRef.current) return;
    let disposed = false;
    let viewer: { clear(): void } | null = null;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, SCI_FETCH_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await fetch(rawFileUrl(path, projectId), { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const length = Number(res.headers.get("content-length") ?? "");
        if (!loadAnyway && Number.isFinite(length) && length > MAX_AUTOLOAD_BYTES) {
          // Bail before pulling the body down; the user opts in explicitly.
          ac.abort();
          if (!disposed) setOversizeBytes(length);
          return;
        }
        const [text, $3Dmol] = await Promise.all([res.text(), import("3dmol")]);
        if (disposed || !mountRef.current) return;
        const v = $3Dmol.createViewer(mountRef.current, { backgroundColor: "white" });
        v.addModel(text, fmtForName(name));
        v.setStyle({}, { cartoon: { color: "spectrum" }, stick: { radius: 0.15 } });
        v.zoomTo();
        v.render();
        viewer = v;
      } catch (e) {
        if (disposed || (isAbortError(e) && !timedOut)) return;
        setViewerErr(
          timedOut
            ? new SciTimeoutError(Math.round(SCI_FETCH_TIMEOUT_MS / 1000)).message
            : String((e as Error)?.message ?? e),
        );
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { disposed = true; clearTimeout(timer); ac.abort(); viewer?.clear?.(); };
  }, [path, name, projectId, loadAnyway]);

  return (
    <div className="flex h-full flex-col">
      {summary && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-semibold">{summary.title}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{summary.num_atoms.toLocaleString()} atoms</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{summary.num_chains} chain{summary.num_chains !== 1 ? "s" : ""}{summary.chains.length ? ` (${summary.chains.slice(0, 8).join(", ")})` : ""}</span>
          {summary.num_ligands > 0 && (<><span className="text-muted-foreground">·</span><span className="text-muted-foreground">{summary.num_ligands} ligand{summary.num_ligands !== 1 ? "s" : ""}</span></>)}
          {summary.resolution != null && (<><span className="text-muted-foreground">·</span><span className="text-muted-foreground">{summary.resolution.toFixed(2)} Å</span></>)}
        </div>
      )}
      {summaryErr && (
        <div className="border-b px-4 py-2 text-xs text-muted-foreground">Metadata unavailable: {summaryErr}</div>
      )}
      <div className="relative flex-1 min-h-0">
        <div ref={mountRef} className="absolute inset-0" />
        {oversizeBytes !== null && !loadAnyway && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              This structure is {formatBytes(oversizeBytes)}
            </p>
            <p className="max-w-md text-xs">
              Rendering it in the browser may make the tab unresponsive for a while.
            </p>
            <button
              onClick={() => setLoadAnyway(true)}
              className="rounded border px-3 py-1 text-xs transition-colors hover:bg-muted"
            >
              Render anyway
            </button>
          </div>
        )}
        {viewerErr && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center text-sm text-muted-foreground">
            3D viewer failed to load: {viewerErr}
          </div>
        )}
      </div>
    </div>
  );
}
