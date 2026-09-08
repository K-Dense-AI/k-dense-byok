"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/projects";
import { normalizeAnalysisPlan, latestFrozenPlan, PLAN_TEXT_FIELDS, planFieldValue,
  type AnalysisPlanInput, type AnalysisPlanHistory, type AnalysisPlanPreview, type PlanTextField, type PlanDeviationInput, type PlanDeviationEvent } from "@/lib/notebook-plans";
import type { NotebookEntry } from "@/lib/notebook";

const fieldClass = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
function emptyPlan(title: string): AnalysisPlanInput {
  return { hypothesis: title, primaryOutcome: "", exclusions: "", model: "", multiplicity: "", qc: "", stopping: "", exposureNotes: "", datasets: [], intent: "exploratory", priorExposure: "unknown" };
}
function PlanDetails({ plan }: { plan: AnalysisPlanInput }) {
  return <dl className="grid gap-2 text-xs [overflow-wrap:anywhere]">
    <div><dt className="font-medium">Declared intent / prior exposure</dt><dd>{plan.intent} / {plan.priorExposure}</dd></div>
    {Object.entries(PLAN_TEXT_FIELDS).map(([key, label]) => <div key={key}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{plan[key as PlanTextField]}</dd></div>)}
    <div><dt className="font-medium">Datasets</dt><dd className="whitespace-pre-wrap">{plan.datasets.join("\n")}</dd></div>
  </dl>;
}

export function NotebookPlanDialog({ entry, sessionId, projectId }: { entry: NotebookEntry; sessionId: string; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AnalysisPlanHistory | null>(entry.planHistory ?? null);
  const [mode, setMode] = useState<"history" | "edit" | "preview" | "deviation">("history");
  const [draft, setDraft] = useState<AnalysisPlanInput>(() => entry.analysisPlan ?? emptyPlan(entry.title));
  const [datasetText, setDatasetText] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [preview, setPreview] = useState<AnalysisPlanPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deviation, setDeviation] = useState<PlanDeviationInput>({ planId: "", field: "model", actual: "", reason: "", timing: "unknown" });
  const lifetime = useRef(0);
  const base = `/sessions/${encodeURIComponent(sessionId)}/notebook/${encodeURIComponent(entry.id)}/plans`;
  const latest = history ? latestFrozenPlan(history) : undefined;
  const [reload, setReload] = useState(0);

  // Project polling can observe a revision approved in another tab. Update the
  // closed control, but never replace a scientist's in-progress review state.
  useEffect(() => {
    if (!open && entry.planHistory && entry.planHistory.events.length > (history?.events.length ?? 0)) setHistory(entry.planHistory);
  }, [entry.planHistory, history?.events.length, open]);

  useEffect(() => {
    if (!open) return;
    const version = ++lifetime.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let disposed = false;
    setBusy(true); setError(""); setMode("history"); setPreview(null);
    void (async () => {
      try {
        const res = await apiFetch(base, { signal: controller.signal, cache: "no-store" }, projectId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail ?? "Could not load plan history");
        if (!controller.signal.aborted && version === lifetime.current) setHistory(data);
      } catch (e) { if (!disposed && version === lifetime.current) { setHistory(null); setError(controller.signal.aborted ? "Plan lookup timed out. Reload history to retry." : (e as Error).message); } }
      finally { clearTimeout(timer); if (!disposed && version === lifetime.current) setBusy(false); }
    })();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); lifetime.current++; };
  }, [open, base, projectId, reload]);

  async function post<T>(action: string, body: unknown): Promise<T | undefined> {
    const version = lifetime.current;
    setBusy(true); setError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await apiFetch(`${base}/${action}`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, projectId);
      const data = await res.json();
      if (version !== lifetime.current) return;
      if (!res.ok) {
        if (res.status === 409 || res.status === 410) { setPreview(null); setMode("history"); setHistory(null); }
        throw new Error(data.detail ?? "Plan operation failed");
      }
      return data as T;
    } catch (e) { if (version === lifetime.current) setError((e as Error).message); }
    finally { clearTimeout(timer); if (version === lifetime.current) setBusy(false); }
  }
  function editPlan() {
    const initial = latest?.plan ?? entry.analysisPlan ?? emptyPlan(entry.title);
    setDraft(initial); setDatasetText(initial.datasets.join("\n")); setRevisionReason("");
    setPreview(null); setConfirm(false); setAllowUnknown(false); setError(""); setMode("edit");
  }
  function editDeviation(previous?: PlanDeviationEvent) {
    setDeviation(previous ? { planId: previous.planId, field: previous.field, actual: previous.actual, reason: "", timing: previous.timing, corrects: previous.id } : { planId: latest!.id, field: "model", actual: "", reason: "", timing: "unknown" });
    setError(""); setMode("deviation");
  }
  async function prepare() {
    try {
      const plan = normalizeAnalysisPlan({ ...draft, datasets: datasetText.split(/\r?\n/).map((p) => p.trim()).filter(Boolean) });
      const data = await post<AnalysisPlanPreview>("preview", { plan, expectedHead: history?.head ?? null, revisionReason });
      if (data) { setPreview(data); setConfirm(false); setAllowUnknown(false); setMode("preview"); }
    } catch (e) { setError((e as Error).message); }
  }
  const selectedPlan = history?.events.find((e) => e.kind === "freeze" && e.id === deviation.planId);
  return <>
    <Button type="button" variant="outline" size="xs" disabled={entry.provisional} onClick={() => setOpen(true)}>
      {latest ? `Analysis plan · revision ${latest.revision}` : entry.analysisPlan ? "Review proposed analysis plan" : "Analysis plan"}
    </Button>
    {entry.planHistoryError && <p className="text-xs text-destructive">Plan history unavailable: {entry.planHistoryError}</p>}
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent className="min-w-0 max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Analysis plan</DialogTitle><DialogDescription>User-approved local records, not external preregistration, proof of data-naivety, or automatic enforcement of a protocol. Freezing does not pause an active analysis. Frozen revisions and deviations are retained without rewriting history.</DialogDescription></DialogHeader>
        {error && <div role="alert" className="rounded border border-destructive/30 p-2 text-sm text-destructive">{error} <Button variant="outline" size="xs" disabled={busy} onClick={() => setReload((n) => n + 1)}>Reload history</Button></div>}
        {busy && <p role="status" className="text-xs">Working…</p>}
        {mode === "history" && history && <div className="space-y-3">
          {!latest && <p className="text-sm">No frozen plan yet. A proposed plan is only an editable draft until you explicitly approve its preview.</p>}
          {history.events.map((event) => <section key={event.id} className="rounded-md border p-3 text-xs [overflow-wrap:anywhere]">
            <p className="font-semibold">{event.kind === "freeze" ? `Frozen revision ${event.revision}` : event.corrects ? "Deviation correction" : "Deviation"} · {new Date(event.recordedAt).toLocaleString()}</p>
            <p className="mt-1 text-muted-foreground">Recorded by you · {event.id}</p>
            {event.kind === "freeze" ? <details className="mt-2"><summary className="cursor-pointer">Inspect immutable plan{event.id === latest?.id ? " (latest revision)" : " (historical revision)"}</summary>
              {event.revisionReason && <p className="my-2">Revision reason: {event.revisionReason}</p>}
              <PlanDetails plan={event.plan} />
              <ul className="mt-2">{event.datasets.map((d, i) => <li key={i}>{d.path}: {d.sha256 ? `sha256 ${d.sha256}` : `unverified (${d.reason})`}</li>)}</ul>
              <p className="mt-2 text-muted-foreground">Record digest: {event.digest}</p>
            </details> : <div className="mt-2 space-y-1">
              <p>Plan {history.events.find((e) => e.id === event.planId && e.kind === "freeze")?.kind === "freeze" ? event.planId : "unavailable"} · {event.field}</p>
              <p className="whitespace-pre-wrap">Planned: {event.planned}</p><p className="whitespace-pre-wrap">Actual: {event.actual}</p><p>Reason: {event.reason}</p>
              <p>Timing: {event.timing} (self-reported)</p>
              {event.corrects && <p>Corrects {event.corrects}; the original remains in the record.</p>}
              {history.events.some((e) => e.kind === "deviation" && e.corrects === event.id) ? <p className="font-medium">A later correction exists; this is historical.</p> : <Button variant="outline" size="xs" disabled={busy} onClick={() => editDeviation(event)}>Correct this deviation</Button>}
            </div>}
          </section>)}
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={editPlan}>{latest ? "Propose a revised plan" : "Prepare plan"}</Button>{latest && <Button variant="outline" size="sm" disabled={busy} onClick={() => editDeviation()}>Record deviation</Button>}</div>
        </div>}
        {mode === "edit" && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
          <p className="text-xs text-muted-foreground">Complete every field. State unknown or not applicable explicitly rather than guessing. Dataset files may be absent or too large to verify, but their unknown identity requires explicit acknowledgement.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">Analysis intent<select aria-label="Analysis intent" className={fieldClass} value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value as AnalysisPlanInput["intent"] })}><option value="exploratory">Exploratory</option><option value="confirmatory">Intended confirmatory (declared)</option></select></label>
            <label className="space-y-1 text-xs">Prior exposure<select aria-label="Prior exposure" className={fieldClass} value={draft.priorExposure} onChange={(e) => setDraft({ ...draft, priorExposure: e.target.value as AnalysisPlanInput["priorExposure"] })}>{["unknown", "none", "metadata-only", "outcomes-inspected"].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          </div>
          {Object.entries(PLAN_TEXT_FIELDS).map(([key, label]) => <label key={key} className="block space-y-1 text-xs">{label}<textarea aria-label={label} required maxLength={4000} rows={2} className={fieldClass} value={draft[key as PlanTextField]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
          <label className="block space-y-1 text-xs">Dataset paths (one per line)<textarea aria-label="Dataset paths" required rows={3} className={fieldClass} value={datasetText} onChange={(e) => setDatasetText(e.target.value)} /></label>
          {latest && <label className="block space-y-1 text-xs">Reason for revision<textarea aria-label="Reason for revision" required maxLength={4000} className={fieldClass} value={revisionReason} onChange={(e) => setRevisionReason(e.target.value)} /></label>}
          <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy}>Review freeze preview</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setMode("history")}>Cancel</Button></div>
        </form>}
        {mode === "preview" && preview && <div className="space-y-3">
          <p className="font-medium">Review exactly what will be frozen</p>
          <PlanDetails plan={preview.plan} />
          <div className="rounded border p-3 text-xs"><p className="font-semibold">Server-measured dataset identities</p><ul className="space-y-1 [overflow-wrap:anywhere]">{preview.datasets.map((d, i) => <li key={i}>{d.path}: {d.sha256 ? `sha256 ${d.sha256}` : `Unverified — ${d.reason}`} · {d.size ?? "unknown"} bytes</li>)}</ul><p className="mt-2">Files are rechecked on confirmation. Unknown identities cannot be proven stable; no historical file copies are retained. Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p></div>
          {preview.plan.intent === "confirmatory" && preview.plan.priorExposure !== "none" && <p className="rounded border border-amber-500/40 p-2 text-xs">Prior exposure is not declared absent. An intended-confirmatory label does not establish a data-independent test.</p>}
          {preview.revisionReason && <p className="text-xs">Reason for revision: {preview.revisionReason}</p>}
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I approve this local plan record; it is not external preregistration or proof that data were unseen.</label>
          {preview.datasets.some((d) => !d.sha256) && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={allowUnknown} onChange={(e) => setAllowUnknown(e.target.checked)} />I acknowledge that some dataset identities are unverified.</label>}
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !confirm || (preview.datasets.some((d) => !d.sha256) && !allowUnknown)} onClick={async () => {
            const saved = await post<AnalysisPlanHistory>("freeze", { previewId: preview.id, acknowledgeLocalFreeze: confirm, acknowledgeUnverified: allowUnknown });
            if (saved) { setHistory(saved); setPreview(null); setMode("history"); }
          }}>Approve and freeze locally</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPreview(null); setMode("edit"); }}>Back to editing</Button></div>
        </div>}
        {mode === "deviation" && history && <form className="space-y-3" onSubmit={async (event) => { event.preventDefault(); const saved = await post<AnalysisPlanHistory>("deviations", { ...deviation, expectedHead: history.head }); if (saved) { setHistory(saved); setMode("history"); } }}>
          <p className="text-sm">{deviation.corrects ? "Correct a deviation (original retained)" : "Record an analysis-plan deviation"}</p>
          <label className="block space-y-1 text-xs">Frozen plan<select aria-label="Frozen plan" className={fieldClass} disabled={Boolean(deviation.corrects)} value={deviation.planId} onChange={(e) => setDeviation({ ...deviation, planId: e.target.value })}>{history.events.filter((e) => e.kind === "freeze").map((e) => <option key={e.id} value={e.id}>Revision {e.revision}</option>)}</select></label>
          <label className="block space-y-1 text-xs">Changed field<select aria-label="Changed field" className={fieldClass} disabled={Boolean(deviation.corrects)} value={deviation.field} onChange={(e) => setDeviation({ ...deviation, field: e.target.value as PlanDeviationInput["field"] })}>{[...Object.entries(PLAN_TEXT_FIELDS), ["datasets", "Datasets"], ["intent", "Intent"], ["priorExposure", "Prior exposure"]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <p className="whitespace-pre-wrap rounded border p-2 text-xs">Planned: {selectedPlan?.kind === "freeze" ? planFieldValue(selectedPlan.plan, deviation.field) : "Unavailable"}</p>
          <label className="block space-y-1 text-xs">What was actually done<textarea aria-label="What was actually done" required maxLength={4000} className={fieldClass} value={deviation.actual} onChange={(e) => setDeviation({ ...deviation, actual: e.target.value })} /></label>
          <label className="block space-y-1 text-xs">Reason for deviation / correction<textarea aria-label="Reason for deviation" required maxLength={4000} className={fieldClass} value={deviation.reason} onChange={(e) => setDeviation({ ...deviation, reason: e.target.value })} /></label>
          <label className="block space-y-1 text-xs">Decision timing<select aria-label="Decision timing" className={fieldClass} value={deviation.timing} onChange={(e) => setDeviation({ ...deviation, timing: e.target.value as PlanDeviationInput["timing"] })}>{["unknown", "before-results", "after-results"].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          <p className="text-xs text-muted-foreground">Timing is self-reported. This records a change; it does not verify execution or rewrite the frozen plan.</p>
          <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy}>Save deviation</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setMode("history")}>Cancel</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
