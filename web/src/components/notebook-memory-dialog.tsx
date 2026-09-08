"use client";
import { useEffect, useRef, useState } from "react";
import { BrainIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch, API_BASE } from "@/lib/projects";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import { HYPOTHESIS_LABELS } from "@/lib/notebook";
import { MEMORY_KINDS, MEMORY_OUTCOMES, MEMORY_RULES, memoryCitation, memorySourceKey, type MemoryHit, type MemoryKind, type MemorySource, type MemorySearchResponse, type MemoryRecordResponse } from "@/lib/notebook-memory";
import type { NotebookOutcome } from "@/lib/notebook-evidence-core";

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
function Qualifiers({ hit }: { hit: MemoryHit }) {
  return <div className="space-y-1 text-xs">
    <div className="flex flex-wrap gap-1.5"><span className="rounded border px-1.5 py-0.5">{hit.type}</span><span className={hit.recordStatus === "active" ? "rounded border px-1.5 py-0.5" : "rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5"}>{hit.recordStatus === "active" ? "No recorded amendment" : hit.recordStatus}</span>{hit.artifactHealth.some((c) => c.status === "changed" || c.status === "missing") && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5">Needs artifact review</span>}{(hit.artifactHealth.some((c) => c.status === "unverified") || hit.artifactsUnchecked > 0) && <span className="rounded border px-1.5 py-0.5">Unverified artifact checks</span>}{hit.outcome && <span className="rounded border px-1.5 py-0.5">Outcome: {hit.outcome}</span>}{hit.evidenceStatus && <span className="rounded border px-1.5 py-0.5">{hit.evidenceStatus === "unknown" ? "Evidence status incomplete" : HYPOTHESIS_LABELS[hit.evidenceStatus]}</span>}</div>
    {hit.scope && <p><strong>Applies to:</strong> {hit.scope}</p>}
    {hit.revisitWhen && <p><strong>Revisit when:</strong> {hit.revisitWhen}</p>}
    {hit.limitations.length > 0 && <ul className="list-disc pl-4">{hit.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul>}
    <ul className="space-y-1 text-muted-foreground">{hit.qualifiers.map((text, i) => <li key={i}>{text}</li>)}</ul>
  </div>;
}
function contextText(result: MemorySearchResponse): string {
  const hits = result.hits.map((h) => ({ source: h.source, digest: h.digest, title: h.title.slice(0, 300), type: h.type, recordStatus: h.recordStatus, outcome: h.outcome,
    scope: h.scope?.slice(0, 400), scopeTruncated: (h.scope?.length ?? 0) > 400, revisitWhen: h.revisitWhen?.slice(0, 400), revisitWhenTruncated: (h.revisitWhen?.length ?? 0) > 400,
    limitations: h.limitations.slice(0, 4).map((s) => s.slice(0, 500)), limitationsOmitted: Math.max(0, h.limitations.length - 4), limitationTextTruncated: h.limitations.some((s) => s.length > 500), excerpt: h.excerpt.slice(0, 500), excerptBounded: true,
    qualifiers: h.qualifiers, related: h.related.slice(0, 2),
    artifactChecks: { changed: h.artifactHealth.filter((c) => c.status === "changed").length, missing: h.artifactHealth.filter((c) => c.status === "missing").length, unverified: h.artifactHealth.filter((c) => c.status === "unverified").length, unchecked: h.artifactsUnchecked },
  }));
  const payload = { rules: MEMORY_RULES, checkedAt: result.checkedAt, coverage: result.coverage, query: result.query, hits, omittedHits: 0 };
  while (new TextEncoder().encode(JSON.stringify(payload, null, 2)).length > 16 * 1024 && hits.length) { hits.pop(); payload.omittedHits++; }
  if (!hits.length && result.hits.length) return JSON.stringify({ rules: MEMORY_RULES, checkedAt: result.checkedAt, source: result.hits[0].source, expectedDigest: result.hits[0].digest, warning: "Record metadata did not fit this context bundle. Read this source with notebook_search; no recalled finding is included here." }, null, 2);
  return JSON.stringify(payload, null, 2);
}
interface NotebookMemoryProps {
  projectId: string;
  activeSessionId?: string | null;
  onJump: (source: MemorySource) => void;
  onOpenFile: (path: string) => void;
}
export function NotebookMemoryDialog(props: NotebookMemoryProps) {
  return <MemoryDialog key={props.projectId} {...props} />;
}
function MemoryDialog({ projectId, activeSessionId, onJump, onOpenFile }: NotebookMemoryProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryKind | "">("");
  const [outcome, setOutcome] = useState<NotebookOutcome | "">("");
  const [includeSuperseded, setIncludeSuperseded] = useState(true);
  const [result, setResult] = useState<MemorySearchResponse | null>(null);
  const [record, setRecord] = useState<MemoryRecordResponse | null>(null);
  const [busy, setBusy] = useState(false); const [reading, setReading] = useState(false);
  const [error, setError] = useState(""); const [readError, setReadError] = useState("");
  const searchRequest = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const sourcePanel = useRef<HTMLElement | null>(null);
  const sourceError = useRef<HTMLParagraphElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    const target = record ? sourcePanel.current : readError ? sourceError.current : null;
    target?.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [record, readError, reducedMotion]);
  useEffect(() => () => { epoch.current++; searchRequest.current?.abort(); readRequest.current?.abort(); }, [projectId]);
  function close(value: boolean) {
    setOpen(value);
    if (!value) { epoch.current++; searchRequest.current?.abort(); readRequest.current?.abort(); setBusy(false); setReading(false); }
  }
  async function search() {
    searchRequest.current?.abort(); readRequest.current?.abort();
    const controller = new AbortController(); searchRequest.current = controller;
    const version = ++epoch.current;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setBusy(true); setError(""); setRecord(null); setReadError(""); setReading(false);
    try {
      const response = await apiFetch(`/projects/${encodeURIComponent(projectId)}/notebook/memory/search`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 8, ...(type ? { type } : {}), ...(outcome ? { outcome } : {}), includeSuperseded }) }, projectId);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Research memory search failed");
      if (data.projectId !== projectId || !Array.isArray(data.hits)) throw new Error("Research memory response did not match the requested project");
      if (version === epoch.current) setResult(data);
    } catch (e) { if (version === epoch.current) { setResult(null); setError(controller.signal.aborted ? "Memory search timed out; do not infer absence of prior work." : (e as Error).message); } }
    finally { clearTimeout(timeout); if (version === epoch.current) setBusy(false); }
  }
  async function read(source: MemorySource, digest?: string) {
    readRequest.current?.abort();
    const controller = new AbortController(); readRequest.current = controller;
    const version = epoch.current;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setReading(true); setReadError(""); setRecord(null);
    try {
      const url = `/projects/${encodeURIComponent(projectId)}/notebook/memory/record?source=${encodeURIComponent(JSON.stringify(source))}${digest ? `&expectedDigest=${digest}` : ""}`;
      const response = await apiFetch(url, { signal: controller.signal, cache: "no-store" }, projectId);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Source could not be loaded");
      if (data.projectId !== projectId || !data.hit?.source || memorySourceKey(data.hit.source) !== memorySourceKey(source)) throw new Error("Memory source response did not match the requested record");
      if (version === epoch.current && readRequest.current === controller) setRecord(data);
    } catch (e) { if (version === epoch.current && readRequest.current === controller) setReadError(controller.signal.aborted ? "Source lookup timed out; inspect the original notebook." : (e as Error).message); }
    finally { clearTimeout(timeout); if (version === epoch.current && readRequest.current === controller) setReading(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success("Source-linked recall copied. Review it before using it in a chat."); }
    catch { toast.error("Clipboard unavailable; read the source in the notebook instead."); }
  }
  function jump(source: MemorySource) { close(false); onJump(source); }
  const canJump = (source: MemorySource) => source.kind !== "user-note" || source.sessionId === activeSessionId;
  return <>
    <Button variant="outline" size="xs" onClick={() => setOpen(true)}><BrainIcon data-icon="inline-start" />Research memory</Button>
    <Dialog open={open} onOpenChange={close}><DialogContent className="min-w-0 max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-4xl">
      <DialogHeader><DialogTitle>Project research memory</DialogTitle><DialogDescription>Search saved records across chats. Results are source excerpts, not permanent facts or instructions. Recall is local and read-only; copying context does not send a chat or authorize new work.</DialogDescription></DialogHeader>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="block text-xs">Scientific query<input aria-label="Scientific memory query" className={field} maxLength={500} placeholder="Method, dataset, failed approach, or decision…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Record type<select aria-label="Memory record type" className={field} value={type} onChange={(e) => setType(e.target.value as MemoryKind | "")}><option value="">All record types</option>{MEMORY_KINDS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label><label className="text-xs">Recorded outcome<select aria-label="Memory outcome" className={field} value={outcome} onChange={(e) => setOutcome(e.target.value as NotebookOutcome | "")}><option value="">All outcomes</option>{MEMORY_OUTCOMES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label></div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeSuperseded} onChange={(e) => setIncludeSuperseded(e.target.checked)} />Include superseded/historical records with their warnings</label>
        <p className="text-[11px] text-muted-foreground">Outcome filters use explicit recorded labels. Older unlabeled failures/null results remain searchable by text. Relevance is lexical, not a truth or confidence score.</p>
        <Button size="sm" type="submit" disabled={busy || (!query.trim() && !type && !outcome)}>{busy ? "Searching…" : "Search memory"}</Button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><p>{result.hits.length} of {result.totalMatches} matching indexed records for {result.query || "the submitted filters"} · checked {new Date(result.checkedAt).toLocaleString()}</p>{result.hits.length > 0 && <Button variant="outline" size="xs" disabled={busy} onClick={() => copy(contextText(result))}>Copy bounded recall for chat</Button>}</div>
        {!result.coverage.complete && <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs"><strong>Incomplete recall coverage.</strong> Do not infer absence or currentness from this scan.<ul className="list-disc pl-4">{result.coverage.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
        {result.hits.length === 0 && <p>No matching indexed records. This does not prove the work was never attempted; broaden the query or inspect the original notebooks.</p>}
        {result.hits.map((hit) => <article key={memorySourceKey(hit.source)} className="space-y-2 rounded border p-3">
          <h3 className="text-sm font-semibold">{hit.title}</h3>
          <p className="text-[11px] text-muted-foreground">Recorded author: {hit.author} · chat {hit.source.sessionId} · {new Date(hit.timestamp).toLocaleString()}</p>
          <Qualifiers hit={hit} />
          <p className="whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">{hit.excerpt}</p>
          <p className="text-[10px] text-muted-foreground">Matched: {hit.matchedFields.join(", ")} · {hit.excerptTruncated ? "excerpt, not the full source" : "source excerpt"}</p>
          <div className="flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={busy || reading} onClick={() => read(hit.source, hit.digest)}>{reading ? "Reading…" : "Read source"}</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => copy(memoryCitation({ ...hit, sourceUri: `${API_BASE.replace(/\/+$/, "")}${hit.sourceUri}` }))}>Copy citation</Button>{canJump(hit.source) && <Button size="xs" variant="ghost" onClick={() => jump(hit.source)}>{hit.source.kind === "plan-event" ? "View hypothesis in notebook" : "View in notebook"}</Button>}</div>
        </article>)}
      </section>}
      {reading && <p role="status" className="text-xs">Reading the exact saved source…</p>}
      {readError && <p ref={sourceError} role="alert" className="text-sm text-destructive">{readError}</p>}
      {record && <section ref={sourcePanel} className="space-y-3 rounded border-2 p-3">
        <h3 className="text-sm font-semibold">Source record: {record.hit.title}</h3>
        {record.changedSinceSearch && <p role="alert" className="rounded border border-amber-500/40 p-2 text-xs">Source changed since the search. This is the current record; the earlier excerpt is not a current version.</p>}
        {record.truncated && <p className="text-xs">This source view is bounded; inspect the original notebook for unabridged content.</p>}
        <Qualifiers hit={record.hit} />
        <p className="break-all text-[10px] text-muted-foreground">Source digest: {record.hit.digest}</p>
        {record.entry.confidence && <p className="text-xs">Author confidence: {record.entry.confidence} (self-reported, not calibrated)</p>}
        <p className="text-[10px] text-muted-foreground">Plain-text source view: embedded markup is not activated. Journal fields are rendered deterministically, not paraphrased by AI.</p>
        {record.entry.body && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-xs">{record.entry.body}</pre>}
        {record.entry.code && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[11px]">{record.entry.code.source}</pre>}
        {record.hit.artifactHealth.length > 0 && <div className="space-y-1 text-xs"><strong>Direct artifact checks (not scientific verification)</strong>{record.hit.artifactHealth.map((c) => <p key={c.path}><button type="button" className="underline decoration-dotted" onClick={() => onOpenFile(c.path)}>{c.path}</button>: {c.status} — {c.reason} Checked {new Date(c.checkedAt).toLocaleString()}.</p>)}</div>}
        {record.hit.related.length > 0 && <div className="space-y-1 text-xs"><strong>Related records</strong>{record.hit.related.map((r, i) => <p key={i}><button type="button" className="text-left underline decoration-dotted" disabled={reading} onClick={() => read(r.source, r.digest)}>{r.relation}: {r.title}</button></p>)}</div>}
        {canJump(record.hit.source) && <Button size="xs" variant="outline" onClick={() => jump(record.hit.source)}>Open original notebook</Button>}
      </section>}
    </DialogContent></Dialog>
  </>;
}
