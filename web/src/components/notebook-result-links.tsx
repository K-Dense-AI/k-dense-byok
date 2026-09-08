"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScientificResultCard } from "./scientific-result-card";
import { apiFetch } from "@/lib/projects";
import { parseScientificResult } from "@/lib/scientific-results";
import type { NotebookEntry } from "@/lib/notebook";
import { resultReferenceText, type NotebookResolvedResult } from "@/lib/notebook-result-links";

export function NotebookResultLinks({ entry, sessionId, projectId, onOpenFile }: {
  entry: NotebookEntry; sessionId: string; projectId: string; onOpenFile: (path: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<NotebookResolvedResult | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    setResult(null); setError("");
    const timer = setTimeout(() => controller.abort(), 15_000);
    let disposed = false;
    void (async () => {
      try {
        const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/notebook/${encodeURIComponent(entry.id)}/results/${selected}`, { signal: controller.signal, cache: "no-store" }, projectId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail ?? "Result lookup failed");
        const card = data.card ? parseScientificResult(data.card) : null;
        if (data.card && !card) throw new Error("Saved result could not be validated");
        if (!disposed) setResult({ ...data, card: card ?? undefined });
      } catch (e) { if (!disposed) setError(controller.signal.aborted ? "Result lookup timed out. Retry when the session log is available." : (e as Error).message); }
      finally { clearTimeout(timer); }
    })();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [entry.id, sessionId, projectId, selected, retry]);
  if (!entry.results?.length) return null;
  return <div className="space-y-1 text-[11px]">
    <p className="font-medium">Recorded scientific results</p>
    {entry.results.map((ref, index) => <div key={`${ref.sessionId}:${ref.toolCallId}:${index}`} className="flex min-w-0 flex-wrap items-center gap-1">
      <Button type="button" variant="outline" size="xs" disabled={entry.provisional} onClick={() => setSelected(index)}>View saved result {index + 1}</Button>
      <span className="break-all text-muted-foreground">{ref.childLocal ? "child-local (not indexed)" : ref.sessionId ?? sessionId}/{ref.toolCallId}</span>
    </div>)}
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <DialogContent className="min-w-0 max-h-[85vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Recorded scientific result</DialogTitle><DialogDescription>Loaded from the persisted tool result, not reconstructed from notebook prose. Artifact previews open current files, not historical snapshots.</DialogDescription></DialogHeader>
        {error && <div role="alert" className="text-sm text-destructive">{error} <Button variant="outline" size="xs" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>}
        {!error && !result && <p role="status">Loading saved result…</p>}
        {result && <>
          <p className="break-all text-xs text-muted-foreground">{resultReferenceText(result.reference)}</p>
          <p className={result.status === "available" ? "text-xs" : "rounded border border-amber-500/40 p-2 text-xs"}>{result.status}: {result.reason}</p>
          {result.card && <ScientificResultCard projectId={projectId} onOpenFile={onOpenFile} item={{ id: `notebook-result-${result.reference.toolCallId}`, label: "Recorded result", toolName: "scientific_result", status: "complete", timestamp: entry.timestamp, scientificResult: result.card }} />}
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
