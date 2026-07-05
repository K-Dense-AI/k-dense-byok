"use client";
import { useEffect, useState } from "react";
import { sciSummaryUrl, sciRenderUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

interface MolInfo {
  index: number; name: string; formula: string; mol_weight: number;
  num_atoms: number; num_bonds: number; smiles: string;
}
interface ChemSummary { format: string; count: number; molecules: MolInfo[] }

export default function MoleculeViewer({ path }: ViewerProps) {
  const [summary, setSummary] = useState<ChemSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null); setError(null);
    fetch(sciSummaryUrl(path, "chem"))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
        return r.json() as Promise<ChemSummary>;
      })
      .then((d) => { if (alive) setSummary(d); })
      .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Molecule preview unavailable</p>
        <p className="max-w-md text-xs">{error}</p>
      </div>
    );
  }
  if (!summary) {
    return <div className="flex h-full items-center justify-center"><div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /></div>;
  }

  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-3 text-xs text-muted-foreground">
        {summary.count > summary.molecules.length
          ? `showing first ${summary.molecules.length} of ${summary.count} molecules`
          : `${summary.count} molecule${summary.count !== 1 ? "s" : ""}`}
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {summary.molecules.map((m) => (
          <div key={m.index} className="overflow-hidden rounded-md border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sciRenderUrl(path, "chem", m.index)} alt={m.name || m.smiles} className="w-full bg-white" />
            <div className="space-y-0.5 border-t p-2 text-xs">
              {m.name && <div className="font-semibold">{m.name}</div>}
              <div className="font-mono text-muted-foreground">{m.formula}</div>
              <div className="text-muted-foreground">MW {m.mol_weight} · {m.num_atoms} atoms · {m.num_bonds} bonds</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground/70" title={m.smiles}>{m.smiles}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
