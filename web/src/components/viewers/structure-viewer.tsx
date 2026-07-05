"use client";
import { useEffect, useRef, useState } from "react";
import { sciSummaryUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

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

export default function StructureViewer({ path, name, content }: ViewerProps) {
  const [summary, setSummary] = useState<StructSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [viewerErr, setViewerErr] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null); setSummaryErr(null);
    fetch(sciSummaryUrl(path, "structure"))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
        return r.json() as Promise<StructSummary>;
      })
      .then((d) => { if (alive) setSummary(d); })
      .catch((e) => { if (alive) setSummaryErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    setViewerErr(null);
    if (!content || !mountRef.current) return;
    let disposed = false;
    let viewer: { clear(): void } | null = null;
    import("3dmol")
      .then(($3Dmol) => {
        if (disposed || !mountRef.current) return;
        const v = $3Dmol.createViewer(mountRef.current, { backgroundColor: "white" });
        v.addModel(content, fmtForName(name));
        v.setStyle({}, { cartoon: { color: "spectrum" }, stick: { radius: 0.15 } });
        v.zoomTo();
        v.render();
        viewer = v;
      })
      .catch((e) => { if (!disposed) setViewerErr(String(e?.message ?? e)); });
    return () => { disposed = true; viewer?.clear?.(); };
  }, [content, name]);

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
        <div ref={mountRef} className="absolute inset-0" style={{ position: "relative" }} />
        {viewerErr && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center text-sm text-muted-foreground">
            3D viewer failed to load: {viewerErr}
          </div>
        )}
      </div>
    </div>
  );
}
