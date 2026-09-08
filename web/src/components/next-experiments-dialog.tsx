"use client";
import { useEffect, useRef, useState } from "react";
import { LightbulbIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/projects";
import { NextExperimentCards } from "./next-experiment-cards";
import { nextExperimentsText, type NextExperimentView, type NextExperimentProposalView } from "@/lib/next-experiments";
import type { NotebookEntry } from "@/lib/notebook";
const field = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
interface Props { entry: NotebookEntry; sessionId: string; projectId: string; model?: string; onSaved?: () => void }
export function NextExperimentsDialog(props: Props) { return <PlanningDialog key={`${props.projectId}:${props.sessionId}:${props.entry.id}`} {...props} />; }
function PlanningDialog({ entry, sessionId, projectId, model, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NextExperimentView | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [constraints, setConstraints] = useState("Prefer informative, low-cost checks using existing data before new collection.");
  const [approveCall, setApproveCall] = useState(false);
  const [lastRequest, setLastRequest] = useState<string | null>(null); const [requestStatus, setRequestStatus] = useState("");
  const [selection, setSelection] = useState<{ proposal: NextExperimentProposalView; candidateId: string } | null>(null);
  const [disposition, setDisposition] = useState<"prioritize" | "defer" | "reject">("prioritize");
  const [reason, setReason] = useState(""); const [ackContext, setAckContext] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null); const epoch = useRef(0);
  const base = `/sessions/${encodeURIComponent(sessionId)}/notebook/${encodeURIComponent(entry.id)}/next-experiments`;
  useEffect(() => { setApproveCall(false); }, [model]);
  useEffect(() => {
    if (!open) return;
    const version = ++epoch.current; const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    setBusy(true); setError(""); setSelection(null); setApproveCall(false);
    void (async () => {
      try {
        const res = await apiFetch(base, { signal: controller.signal, cache: "no-store" }, projectId);
        const data = await res.json(); if (!res.ok) throw new Error(data.detail ?? "Could not read proposal context");
        if (data.context?.projectId !== projectId || data.context?.source.sessionId !== sessionId || data.context?.source.entryId !== entry.id) throw new Error("Proposal context did not match this project/hypothesis");
        if (version === epoch.current && !controller.signal.aborted) setView(data);
      } catch (e) { if (version === epoch.current) { setView(null); setError(controller.signal.aborted ? "Context read timed out; refresh to retry." : (e as Error).message); } }
      finally { clearTimeout(timer); if (version === epoch.current) setBusy(false); }
    })();
    return () => { epoch.current++; controller.abort(); request.current?.abort(); clearTimeout(timer); };
  }, [open, reload, base, projectId, sessionId, entry.id]);
  async function post<T>(suffix: string, body: unknown): Promise<T | undefined> {
    const version = epoch.current; const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 120_000);
    setBusy(true); setError("");
    try {
      const res = await apiFetch(base + suffix, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, projectId);
      const data = await res.json();
      if (!res.ok) throw new Error(`${data.detail ?? "Planning request failed"}${data.modelCallRecorded ? ` (model usage recorded${typeof data.costUsd === "number" ? `: $${data.costUsd.toFixed(6)}` : ""})` : ""}`);
      if (version === epoch.current) return data;
    } catch (e) { if (version === epoch.current) setError(controller.signal.aborted ? "Request timed out; a model call may still be running or recorded. Check the request status and notebook before approving a new call." : (e as Error).message); }
    finally { clearTimeout(timer); if (version === epoch.current) setBusy(false); }
  }
  async function checkRequest() {
    if (!lastRequest) return;
    const version = epoch.current; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await apiFetch(`${base}/requests/${lastRequest}`, { cache: "no-store", signal: controller.signal }, projectId); const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Request status unavailable");
      if (version === epoch.current) setRequestStatus(`${data.state}${data.error?.message ? `: ${data.error.message}` : ""}. Checking status does not retry a model call.`);
    } catch (e) { if (version === epoch.current) setRequestStatus((e as Error).message); }
    finally { clearTimeout(timer); if (version === epoch.current) setBusy(false); }
  }
  async function copy(proposal: NextExperimentProposalView) {
    try { await navigator.clipboard.writeText(`${nextExperimentsText(proposal.plan)}\n\nSource proposal: ${proposal.source.sessionId}/${proposal.source.entryId}\nDigest: ${proposal.digest}\nContext status: ${proposal.contextStatus}\nOmitted source sessions default to ${proposal.source.sessionId}.\nThis is a planning brief, not authorization to execute or spend.`); toast.success("Planning brief copied; nothing was executed."); }
    catch { toast.error("Clipboard unavailable"); }
  }
  return <>
    <Button type="button" variant="outline" size="xs" disabled={entry.provisional} onClick={() => setOpen(true)}><LightbulbIcon data-icon="inline-start" />What next?</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}><DialogContent className="min-w-0 max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-4xl">
      <DialogHeader><DialogTitle>What should we test next?</DialogTitle><DialogDescription>Proposed investigations—not findings or execution approvals. Compare competing explanations and decide which result would change your next step.</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={busy} onClick={() => setReload((n) => n + 1)}>Refresh sources and proposals</Button>{busy && <span role="status" className="text-xs">Working…</span>}</div>
      {error && <p role="alert" className="rounded border border-destructive/30 p-2 text-sm text-destructive">{error}</p>}
      {view && <>
        <details className="rounded border p-2"><summary className="cursor-pointer text-xs font-medium">Grounding context · {view.context.sources.length} selected sources · {view.context.targetStatus}</summary>
          <p className="my-2 text-[11px] text-muted-foreground">Bounded original records, not exhaustive project evidence. Context captured {new Date(view.context.capturedAt).toLocaleString()}; digest {view.context.digest}. Proposal/preference records are excluded as evidence.</p>
          {view.context.sources.map((s, i) => <details key={i} className="border-t py-1 text-xs"><summary className="cursor-pointer">{s.hit.type}: {s.hit.title} · {s.hit.recordStatus}</summary><p>{s.hit.scope}</p><p>{s.hit.qualifiers.join(" ")}</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-[11px]">{s.text}</pre>{s.textTruncated && <p>Excerpt bounded; consult the original source.</p>}<p className="break-all text-[10px]">{JSON.stringify(s.hit.source)} · {s.hit.digest}</p></details>)}
          {view.context.artifacts.map((a) => <p key={a.path} className="mt-1 text-[10px]">{a.path}: {a.sha256 ?? `unverified (${a.reason ?? "unknown"})`}</p>)}
        </details>
        {view.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
        <details open={view.proposals.length === 0} className="space-y-2 rounded border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Generate a source-linked proposal</summary>
          <label className="block text-xs">Current decision constraints<textarea aria-label="Decision constraints" rows={3} maxLength={4000} className={field} value={constraints} onChange={(e) => { setConstraints(e.target.value); setApproveCall(false); }} /></label>
          <p className="text-xs">Model: <strong>{model ?? "configured default model"}</strong>. This makes one model call using bounded source excerpts and your constraints. Normal provider usage applies; failed/invalid returned responses are also ledgered. No experiments or compute jobs are launched.</p>
          {model?.startsWith("fusion/") && <p className="text-xs text-destructive">Choose a non-Fusion model for this one-shot call.</p>}
          {view.context.targetStatus === "superseded" && <p className="text-xs">This hypothesis is historical. Use its amended version to generate or choose new tests.</p>}
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={approveCall} onChange={(e) => setApproveCall(e.target.checked)} />I approve one planning-model call with this bounded project context; this does not approve any experiment or spending on execution.</label>
          <Button size="sm" disabled={busy || !approveCall || model?.startsWith("fusion/") || view.context.targetStatus === "superseded"} onClick={async () => {
            const requestId = crypto.randomUUID(); setLastRequest(requestId); setRequestStatus(""); setApproveCall(false);
            const result = await post("/generate", { model, constraints, expectedContextDigest: view.context.digest, requestId, approveModelCall: true });
            if (result) { onSaved?.(); toast.success("Planning proposal saved; no experiment was run."); setReload((n) => n + 1); }
          }}>Generate proposals</Button>
          {lastRequest && <div className="space-y-1 text-[11px]"><p>Last request: {lastRequest}</p><Button variant="ghost" size="xs" disabled={busy} onClick={checkRequest}>Check request status (no retry)</Button>{requestStatus && <p>{requestStatus}</p>}</div>}
        </details>
        {!view.proposals.length && <p className="text-sm text-muted-foreground">No saved next-investigation proposals yet. Kady can also author one through the notebook tool during a normal chat.</p>}
        {view.proposals.map((proposal) => <details key={`${proposal.source.sessionId}:${proposal.source.entryId}`} open={view.proposals.length === 1} className="rounded border p-3">
          <summary className="cursor-pointer text-sm font-semibold">{proposal.plan.question} · {proposal.status} · context {proposal.contextStatus}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs">Recorded author: {proposal.author} · {new Date(proposal.timestamp).toLocaleString()}. Source {proposal.source.sessionId}/{proposal.source.entryId}.</p>
            {proposal.binding?.generation && <p className="text-[11px] text-muted-foreground">Planning model: {proposal.binding.generation.model} · recorded project spend ${proposal.binding.generation.costUsd.toFixed(6)}{proposal.binding.generation.billingMode ? ` (${proposal.binding.generation.billingMode})` : ""}. Provider quotas/charges remain external; this is not an experiment-cost quote.</p>}
            {proposal.contextStatus !== "current" && <p className="rounded border border-amber-500/40 p-2 text-xs">Source context is {proposal.contextStatus}. Review changed, missing or unverified evidence before using these ideas. A matching record digest alone does not verify scientific validity.</p>}
            {proposal.binding?.contextChangedDuringGeneration && <p className="text-xs">The context changed or could not be rechecked while the proposal was being generated.</p>}
            {Boolean(proposal.binding?.artifacts?.length) && <details className="rounded border p-2 text-xs"><summary className="cursor-pointer">Planning-time file identities (hashes only, not retained bytes)</summary>{proposal.binding!.artifacts!.map((a) => {
              const current = view.context.artifacts.find((c) => c.path === a.path);
              const status = !a.sha256 || !current?.sha256 ? "unverified / unavailable" : a.sha256 === current.sha256 ? "same planning-time bytes" : "changed since planning";
              return <p key={a.path} className="mt-1 break-all">{a.path}: {status}. Recorded SHA-256: {a.sha256 ?? a.reason ?? "unknown"}.</p>;
            })}</details>}
            <NextExperimentCards plan={proposal.plan} projectId={projectId} sessionId={proposal.source.sessionId} sourceDigests={proposal.binding?.sourceDigests} actions={(candidate) => {
              const choices = proposal.decisions.filter((d) => d.choice.candidateId === candidate.id);
              const latest = choices.filter((d) => d.choice.proposal.digest === proposal.digest).at(-1);
              return <div className="space-y-2 border-t pt-2 text-xs">
                {latest && <p>Latest user preference: <strong>{latest.choice.disposition}</strong> — {latest.choice.reason}. {latest.choice.contextDigest !== view.context.digest && "Source context changed since this preference. "}Not execution approval.</p>}
                {choices.length > 0 && <details><summary className="cursor-pointer">Preference history ({choices.length})</summary>{choices.map((d) => <p key={d.id}>{new Date(d.timestamp).toLocaleString()}: {d.choice.disposition} — {d.choice.reason} (context {d.choice.proposalContextStatus}; {d.choice.proposal.digest === proposal.digest ? "same proposal version" : "earlier proposal version"})</p>)}</details>}
                <Button size="xs" variant="outline" disabled={busy || proposal.status === "superseded" || view.context.targetStatus === "superseded"} onClick={() => { setSelection({ proposal, candidateId: candidate.id }); setDisposition("prioritize"); setReason(""); setAckContext(false); }}>Record planning preference</Button>
                {selection?.proposal.digest === proposal.digest && selection.candidateId === candidate.id && <form className="space-y-2 rounded border p-2" onSubmit={async (e) => {
                  e.preventDefault(); const saved = await post("/decision", { proposal: proposal.source, expectedProposalDigest: proposal.digest, expectedContextDigest: view.context.digest, candidateId: candidate.id, disposition, reason, requestId: crypto.randomUUID(), acknowledgeUnverifiedContext: ackContext });
                  if (saved) { onSaved?.(); setSelection(null); setReload((n) => n + 1); toast.success("Planning preference recorded; nothing was executed or approved to run."); }
                }}>
                  <label className="block">Preference<select aria-label="Planning preference" className={field} value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)}><option value="prioritize">Prioritize for planning</option><option value="defer">Defer</option><option value="reject">Reject this option</option></select></label>
                  <label className="block">Reason<textarea aria-label="Planning preference reason" className={field} required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                  {proposal.contextStatus !== "current" && <label className="flex items-start gap-2"><input type="checkbox" checked={ackContext} onChange={(e) => setAckContext(e.target.checked)} />I reviewed the changed/unverified source context; this is a planning preference only.</label>}
                  <p>This appends a decision record. It does not freeze a protocol, submit compute, place an order or authorize data collection.</p>
                  <Button type="submit" size="xs" disabled={busy || !reason.trim() || proposal.contextStatus !== "current" && !ackContext}>Save preference (no execution)</Button>
                </form>}
              </div>;
            }} />
            <Button variant="outline" size="xs" onClick={() => copy(proposal)}>Copy planning brief</Button>
            <p className="text-xs text-muted-foreground">To act, prepare a current analysis plan and obtain any required ethics/resource approvals. Computational sensitivity runs still require the separate Stress-test finding snapshot/budget approval. No numerical information-gain calculation is supplied in this stage.</p>
          </div>
        </details>)}
      </>}
    </DialogContent></Dialog>
  </>;
}
