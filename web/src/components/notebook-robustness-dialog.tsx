"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/projects";
import { latestFrozenPlan, type AnalysisPlanHistory } from "@/lib/notebook-plans";
import { normalizeRobustnessDraft, summarizeRobustness, robustnessText, type RobustnessDraft, type RobustnessPreview, type RobustnessWorkflow } from "@/lib/notebook-robustness";
import type { NotebookEntry } from "@/lib/notebook";

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
const activeStates = new Set(["awaiting-admission", "queued", "preparing", "running", "collecting"]);
const blank = (entry: NotebookEntry): RobustnessDraft => ({ title: entry.title, script: "", inputs: [], metric: "", unit: "", nullValue: 0, instance: "cpu-2", timeoutSec: 600, packages: [], specifications: [
  { key: "baseline", label: "Baseline", rationale: "", seed: 42, parametersJson: "{}" },
  { key: "alternative", label: "Alternative", rationale: "", seed: 42, parametersJson: "{}" },
] });

export function RobustnessResults({ workflow, onOpenFile }: { workflow: RobustnessWorkflow; onOpenFile?: (path: string) => void }) {
  const { attempts, preview } = workflow;
  const summary = summarizeRobustness(attempts);
  const plotted = attempts.filter((a) => a.state === "succeeded" && a.resultStatus === "available" && a.result?.estimate !== undefined);
  const values = [preview.draft.nullValue, ...plotted.flatMap((a) => [a.result!.estimate!, ...(a.result!.interval ? [a.result!.interval.low, a.result!.interval.high] : [])])];
  const magnitude = Math.max(1, ...values.map(Math.abs));
  const scaled = values.map((n) => n / magnitude);
  const lo = Math.min(...scaled) - 0.05; const hi = Math.max(...scaled) + 0.05;
  const x = (n: number) => 220 + (n / magnitude - lo) / (hi - lo) * 400;
  return <section className="space-y-3">
    {workflow.admissionError && <p role="alert" className="rounded border border-destructive/40 p-2 text-sm">Admission failed: {workflow.admissionError}. All specifications are retained; no automatic retry.</p>}
    {workflow.cancelled && <p className="text-xs">Cancellation requested. Already completed attempts remain recorded.</p>}
    <p className="text-sm"><strong>{summary.eligible}/{summary.total} comparable QC-pass outputs.</strong> {summary.eligible ? `Estimate range ${summary.min} to ${summary.max}; median ${summary.median}.` : "No eligible estimates to summarize."}</p>
    <p className="text-xs text-muted-foreground">{preview.draft.metric} · {preview.draft.unit}. Descriptive sensitivity only—not a significance vote, probability of truth, or independent replication. Failed, missing, invalid and QC-warn/fail outputs are excluded from the range, not from the record.</p>
    {plotted.length > 0 && <figure className="overflow-x-auto rounded border p-2">
      <svg role="img" aria-label="Specification estimates and supplied uncertainty intervals" viewBox={`0 0 660 ${plotted.length * 30 + 35}`} className="w-full min-w-[560px]">
        <line x1={x(preview.draft.nullValue)} x2={x(preview.draft.nullValue)} y1="5" y2={plotted.length * 30 + 10} stroke="currentColor" strokeDasharray="3 3" opacity="0.4" />
        {plotted.map((a, i) => <g key={a.jobId}><title>{a.specification.label}: {a.result!.estimate}; QC {a.result!.qc}</title>
          <text x="4" y={i * 30 + 24} fill="currentColor" fontSize="11">{a.specification.key.slice(0, 30)}</text>
          {a.result!.interval && <line x1={x(a.result!.interval.low)} x2={x(a.result!.interval.high)} y1={i * 30 + 20} y2={i * 30 + 20} stroke={a.result!.qc === "pass" ? "#0d9488" : "#d97706"} strokeWidth="2" />}
          <circle cx={x(a.result!.estimate!)} cy={i * 30 + 20} r="4" fill={a.result!.qc === "pass" ? "#0d9488" : "#d97706"} />
        </g>)}
        <text x="220" y={plotted.length * 30 + 28} fontSize="10" fill="currentColor">Reference null = {preview.draft.nullValue}</text>
      </svg>
      <figcaption className="text-[10px] text-muted-foreground">Plot and table scroll horizontally on narrow screens. Successful valid outputs only. Teal: QC pass; amber: QC warn/fail (excluded from summary). Dots without bars have no supplied interval. Interval levels may differ; inspect the table. QC and estimates are script output, not independent scientific verification.</figcaption>
    </figure>}
    <div className="overflow-x-auto rounded border"><table className="w-full min-w-[640px] text-left text-xs"><thead><tr className="border-b bg-muted/30"><th className="p-2">Specification</th><th className="p-2">Job state</th><th className="p-2">Estimate / uncertainty</th><th className="p-2">QC / validation</th><th className="p-2">Estimated cost</th></tr></thead><tbody>
      {attempts.map((a) => <tr key={a.jobId} className="border-b align-top last:border-0"><td className="max-w-56 p-2"><strong>{a.specification.label}</strong><p className="text-muted-foreground">{a.specification.rationale}</p><p>Seed {a.specification.seed}</p><code className="break-all text-[10px]">{a.jobId}</code><details><summary className="cursor-pointer">Parameters</summary><pre className="whitespace-pre-wrap break-all">{a.specification.parametersJson}</pre></details></td>
        <td className="max-w-44 p-2">{a.state}{a.error && <p className="mt-1 text-destructive">{a.error}</p>}</td>
        <td className="p-2">{a.result ? <>{a.result.estimate ?? "Not estimated"}<p>{a.result.interval ? `[${a.result.interval.low}, ${a.result.interval.high}] at ${(a.result.interval.level * 100).toFixed(1)}%` : "Interval not provided"}</p><p>{a.result.sampleSize ? `n=${a.result.sampleSize}` : "Sample size not provided"}</p></> : "No estimate inferred"}</td>
        <td className="max-w-52 p-2">{a.result?.qc ?? "—"} · {a.resultStatus}{a.resultReason && <p>{a.resultReason}</p>}{a.result?.notes && <p>{a.result.notes}</p>}{onOpenFile && a.resultStatus !== "pending" && a.resultStatus !== "missing" && <Button variant="ghost" size="xs" onClick={() => onOpenFile(a.outputPath)}>Open current JSON</Button>}</td>
        <td className="p-2">{a.estimatedCostUsd !== undefined ? `$${a.estimatedCostUsd.toFixed(6)}` : "Pending"}{!a.reconciled && <p>Unreconciled</p>}</td>
      </tr>)}
    </tbody></table></div>
    <p className="text-[10px] text-muted-foreground">Values above come from retained, checksummed Modal output staging. “Open current JSON” opens today's sandbox file, which may have changed. Job ids link this record to logs and provenance in the Compute tab. Unconfirmed launches/cleanup can conservatively consume the full approved estimate; this is not Modal invoice reconciliation.</p>
  </section>;
}

export function NotebookRobustnessDialog({ entry, sessionId, projectId, onOpenFile }: { entry: NotebookEntry; sessionId: string; projectId: string; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"history" | "edit" | "review">("history");
  const [draft, setDraft] = useState<RobustnessDraft>(() => entry.robustness ?? blank(entry));
  const [inputs, setInputs] = useState(""); const [packages, setPackages] = useState("");
  const [preview, setPreview] = useState<RobustnessPreview | null>(null);
  const [history, setHistory] = useState<RobustnessWorkflow[]>([]);
  const [plans, setPlans] = useState<AnalysisPlanHistory | null>(null);
  const [instances, setInstances] = useState<{ id: string; label: string; pricePerHour: number }[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [scriptOk, setScriptOk] = useState(false); const [remoteOk, setRemoteOk] = useState(false);
  const [costOk, setCostOk] = useState(false); const [unknownOk, setUnknownOk] = useState(false);
  const [maxCost, setMaxCost] = useState(""); const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const base = `/sessions/${encodeURIComponent(sessionId)}/notebook/${encodeURIComponent(entry.id)}`;
  const frozen = plans ? latestFrozenPlan(plans) : undefined;
  useEffect(() => {
    if (!open) return;
    const version = ++epoch.current; const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000); let disposed = false;
    setBusy(true); setError("");
    void (async () => {
      try {
        const responses = await Promise.all([`${base}/robustness`, `${base}/plans`, "/modal/instances"].map((url) => apiFetch(url, { signal: controller.signal, cache: "no-store" }, projectId)));
        const data = await Promise.all(responses.map((r) => r.json()));
        const bad = responses.findIndex((r) => !r.ok); if (bad >= 0) throw new Error(data[bad].detail ?? "Could not load robustness context");
        if (!disposed && version === epoch.current) { setHistory(data[0].workflows); setLoadErrors(data[0].errors ?? []); setConfigured(data[0].configured); setPlans(data[1]); setInstances(data[2].instances ?? []); }
      } catch (e) { if (!disposed && version === epoch.current) setError(controller.signal.aborted ? "Context lookup timed out; refresh to retry." : (e as Error).message); }
      finally { clearTimeout(timeout); if (!disposed && version === epoch.current) setBusy(false); }
    })();
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); epoch.current++; };
  }, [open, base, projectId, refresh]);
  const hasActive = history.some((w) => w.attempts.some((a) => activeStates.has(a.state)));
  useEffect(() => {
    if (!open || mode !== "history") return;
    const timer = setInterval(() => { if (!document.hidden && !busy) setRefresh((n) => n + 1); }, hasActive ? 5000 : 30_000);
    return () => clearInterval(timer);
  }, [open, mode, hasActive, busy]);
  async function post<T>(suffix: string, body: unknown): Promise<T | undefined> {
    const version = epoch.current; setBusy(true); setError("");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await apiFetch(`${base}/robustness/${suffix}`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, projectId);
      const data = await response.json();
      if (version !== epoch.current) return;
      if (!response.ok) { if (response.status === 409 || response.status === 410) { setPreview(null); setMode("edit"); } throw new Error(data.detail ?? "Robustness operation failed"); }
      return data;
    } catch (e) { if (version === epoch.current) setError(controller.signal.aborted ? "Request timed out. Approval may have been recorded; refresh history before retrying. Reusing the same approval never creates another batch." : (e as Error).message); }
    finally { clearTimeout(timer); if (version === epoch.current) setBusy(false); }
  }
  function edit(initial = entry.robustness ?? blank(entry)) {
    setDraft(initial); setInputs(initial.inputs.join("\n")); setPackages(initial.packages.join("\n")); setPreview(null); setMode("edit"); setError("");
  }
  function exportWorkflow(workflow: RobustnessWorkflow, format: "json" | "md" = "json") {
    const url = URL.createObjectURL(new Blob([format === "json" ? JSON.stringify(workflow, null, 2) : robustnessText([workflow])], { type: format === "json" ? "application/json" : "text/markdown" }));
    const a = document.createElement("a"); a.href = url; a.download = `robustness-${workflow.preview.id}.${format}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  return <>
    <Button variant="outline" size="xs" disabled={entry.provisional} onClick={() => setOpen(true)}>Stress-test finding</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}><DialogContent className="min-w-0 max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-4xl">
      <DialogHeader><DialogTitle>Stress-test this finding</DialogTitle><DialogDescription>Review defensible alternatives before execution. This runs your script remotely on Modal using the exact reviewed file snapshots; it is not an automatic significance search or independent replication.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="rounded border border-destructive/30 p-2 text-sm text-destructive">{error}</p>}
      {loadErrors.map((e, i) => <p key={i} role="alert" className="text-xs text-destructive">Some history is unavailable: {e}</p>)}
      <div className="flex flex-wrap items-center gap-2 text-xs"><Button size="xs" variant="outline" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>Refresh context/history</Button>{busy && <span role="status">Working…</span>}{!configured && <span>Configure Modal credentials in Settings before approval.</span>}</div>
      {mode === "history" && <div className="space-y-4">
        {!frozen && <p>Freeze an analysis plan first using the hypothesis's Analysis plan control, then refresh here.</p>}
        {frozen && <p className="text-xs">Latest local frozen plan: revision {frozen.revision}. New work must be reviewed against this revision; existing workflows retain their original plan.</p>}
        <Button size="sm" disabled={busy || !frozen} onClick={() => edit()}>Prepare robustness workflow</Button>
        {!history.length && <p className="text-sm text-muted-foreground">No approved robustness workflows yet.</p>}
        {history.map((w) => <details key={w.preview.id} open={history.length === 1} className="rounded border p-3"><summary className="cursor-pointer text-sm font-semibold">{w.preview.draft.title} · {w.preview.id}</summary>
          <div className="mt-3 space-y-3"><p className="text-xs">Approved {w.approvedAt ? new Date(w.approvedAt).toLocaleString() : "not yet"} · plan revision {w.preview.planRevision} · max estimated sandbox commitment ${w.preview.totalReservationUsd.toFixed(6)}</p>
            <RobustnessResults workflow={w} onOpenFile={onOpenFile} />
            <details><summary className="cursor-pointer text-xs">Exact approved recipe</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] whitespace-pre-wrap break-all">{JSON.stringify(w.preview.draft, null, 2)}</pre></details>
            <details><summary className="cursor-pointer text-xs">Approved Python snapshot</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] whitespace-pre-wrap break-all">{w.preview.scriptSource}</pre></details>
            <div className="flex flex-wrap gap-2"><Button variant="outline" size="xs" onClick={() => exportWorkflow(w)}>Export workflow JSON</Button><Button variant="outline" size="xs" onClick={() => exportWorkflow(w, "md")}>Export summary Markdown</Button><Button variant="outline" size="xs" disabled={busy || !frozen} onClick={() => edit(w.preview.draft)}>New reviewed workflow</Button>
              {w.attempts.some((a) => activeStates.has(a.state)) && !w.cancelled && <Button variant="outline" size="xs" disabled={busy} onClick={async () => { const next = await post<RobustnessWorkflow>(`${w.preview.id}/cancel`, {}); if (next) setHistory((old) => old.map((item) => item.preview.id === next.preview.id ? next : item)); }}>Cancel remaining jobs</Button>}
            </div>
          </div>
        </details>)}
      </div>}
      {mode === "edit" && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        try {
          const recipe = normalizeRobustnessDraft({ ...draft, inputs: inputs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), packages: packages.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
          const p = await post<RobustnessPreview>("preview", { draft: recipe, planId: frozen?.id, expectedPlanHead: plans?.head });
          if (p) { setPreview(p); setScriptOk(false); setRemoteOk(false); setCostOk(false); setUnknownOk(false); setMaxCost(String(Math.ceil(p.totalReservationUsd * 1e6) / 1e6)); setMode("review"); }
        } catch (e) { setError((e as Error).message); }
      }}>
        <p className="text-xs">Python script contract: accept <code>--spec JSON_PATH --output RESULT_PATH</code>. Spec contains metric, unit, nullValue, seed and parameters. Honor the seed in every library used. Write JSON with schemaVersion=1, matching metric/unit, estimate, qc=pass|warn|fail (omit estimate if QC failed and it cannot be computed), optionally interval &#123;low,high,level&#125;, sampleSize and notes. No code runs locally during preview.</p>
        <label className="block text-xs">Workflow title<input aria-label="Workflow title" className={field} value={draft.title} maxLength={200} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label className="block text-xs">Existing Python script<input aria-label="Existing Python script" className={field} value={draft.script} required onChange={(e) => setDraft({ ...draft, script: e.target.value })} /></label>
        <label className="block text-xs">Explicit input files (one per line; include all plan datasets and helpers)<textarea aria-label="Explicit input files" className={field} rows={3} value={inputs} onChange={(e) => setInputs(e.target.value)} /></label>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs">Common effect metric<input aria-label="Common effect metric" className={field} required value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} /></label>
          <label className="text-xs">Common unit / scale<input aria-label="Common unit" className={field} required value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></label>
          <label className="text-xs">Reference null (e.g. 0 for difference, 1 for ratio)<input aria-label="Reference null" className={field} type="number" step="any" required value={draft.nullValue} onChange={(e) => setDraft({ ...draft, nullValue: Number(e.target.value) })} /></label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Resource per variation<select aria-label="Resource per variation" className={field} value={draft.instance} onChange={(e) => setDraft({ ...draft, instance: e.target.value })}>{instances.map((i) => <option key={i.id} value={i.id}>{i.label} · est. ${i.pricePerHour}/h</option>)}</select></label><label className="text-xs">Maximum seconds per variation<input aria-label="Maximum seconds per variation" className={field} type="number" min={1} max={3600} value={draft.timeoutSec} onChange={(e) => setDraft({ ...draft, timeoutSec: Number(e.target.value) })} /></label></div>
        <label className="block text-xs">Exact PyPI package==version pins (one per line)<textarea aria-label="Package pins" className={field} rows={2} value={packages} onChange={(e) => setPackages(e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">Image recipe: python:3.13-slim + these pins; no shared project cache, named environment, GPU fallback or automatic retry. This recipe is not a bit-for-bit image digest guarantee.</p>
        {draft.specifications.map((s, index) => <fieldset key={index} className="space-y-2 rounded border p-3"><legend className="px-1 text-xs font-semibold">Variation {index + 1}</legend>
          <div className="grid gap-2 sm:grid-cols-3">{(["key", "label", "seed"] as const).map((name) => <label key={name} className="text-xs">{name}<input aria-label={`Variation ${index + 1} ${name}`} className={field} required type={name === "seed" ? "number" : "text"} value={s[name]} onChange={(e) => setDraft({ ...draft, specifications: draft.specifications.map((row, i) => i === index ? { ...row, [name]: name === "seed" ? Number(e.target.value) : e.target.value } : row) })} /></label>)}</div>
          <label className="block text-xs">Scientific rationale<textarea aria-label={`Variation ${index + 1} rationale`} className={field} required maxLength={2000} value={s.rationale} onChange={(e) => setDraft({ ...draft, specifications: draft.specifications.map((row, i) => i === index ? { ...row, rationale: e.target.value } : row) })} /></label>
          <label className="block text-xs">Parameter JSON object<textarea aria-label={`Variation ${index + 1} parameters`} className={`${field} font-mono`} required maxLength={8000} value={s.parametersJson} onChange={(e) => setDraft({ ...draft, specifications: draft.specifications.map((row, i) => i === index ? { ...row, parametersJson: e.target.value } : row) })} /></label>
          <Button type="button" size="xs" variant="ghost" disabled={draft.specifications.length <= 2} onClick={() => setDraft({ ...draft, specifications: draft.specifications.filter((_, i) => i !== index) })}>Remove before approval</Button>
        </fieldset>)}
        <div className="flex flex-wrap gap-2"><Button type="button" size="xs" variant="outline" disabled={draft.specifications.length >= 16} onClick={() => setDraft({ ...draft, specifications: [...draft.specifications, { key: `variation_${draft.specifications.length + 1}`, label: "", rationale: "", seed: 42, parametersJson: "{}" }] })}>Add variation</Button><Button type="submit" size="sm" disabled={busy || !frozen}>Prepare snapshot and quote</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setMode("history")}>Back</Button></div>
      </form>}
      {mode === "review" && preview && <div className="space-y-3">
        <h3 className="font-semibold">Review exact snapshot and all {preview.jobs.length} specifications</h3>
        <p className="text-sm">Maximum estimated sandbox commitment: <strong>${preview.totalReservationUsd.toFixed(6)}</strong> · {preview.draft.instance} × {preview.jobs.length} × up to {preview.draft.timeoutSec}s. No fallback or automatic retry.</p>
        <p className="rounded border border-amber-500/40 p-2 text-xs">This is an estimate, not a Modal invoice cap. Image builds, storage, transfer and provider pricing may differ. Uncertain launches or cleanup may conservatively consume the full approved estimate. The project spend cap is rechecked for the entire batch before any remote job starts.</p>
        <p className="text-xs">Frozen plan revision {preview.planRevision}; preview expires {new Date(preview.expiresAt).toLocaleString()}. Reviewed snapshots—not later file edits—will be executed. The script controls the scientific method and use of seeds; these are not independently validated.</p>
        <details open><summary className="cursor-pointer text-sm">Exact Python script: {preview.draft.script}</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[11px] whitespace-pre-wrap break-all">{preview.scriptSource}</pre></details>
        <details><summary className="cursor-pointer text-xs">Input file identities and execution commands</summary><pre className="max-h-64 overflow-auto p-2 text-[10px] whitespace-pre-wrap break-all">{JSON.stringify({ inputs: preview.inputFiles, generated: preview.generatedFiles, jobs: preview.jobs, packages: preview.draft.packages }, null, 2)}</pre></details>
        {preview.draft.specifications.map((s) => <div key={s.key} className="rounded border p-2 text-xs"><strong>{s.label}</strong> ({s.key}, seed {s.seed})<p>{s.rationale}</p><pre className="whitespace-pre-wrap break-all">{s.parametersJson}</pre></div>)}
        {preview.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700 dark:text-amber-300">{warning}</p>)}
        <label className="block text-xs">Approved maximum estimated USD<input aria-label="Approved maximum estimated USD" type="number" step="any" min={preview.totalReservationUsd} className={field} value={maxCost} onChange={(e) => setMaxCost(e.target.value)} /></label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={scriptOk} onChange={(e) => setScriptOk(e.target.checked)} />I reviewed this exact script, input list and all specifications for scientific defensibility.</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={remoteOk} onChange={(e) => setRemoteOk(e.target.checked)} />I authorize uploading these files and executing this code remotely on Modal.</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={costOk} onChange={(e) => setCostOk(e.target.checked)} />I approve the estimated commitment and understand it is not an invoice cap.</label>
        {preview.warnings.length > 0 && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={unknownOk} onChange={(e) => setUnknownOk(e.target.checked)} />I acknowledge that some original plan dataset identities were unverified.</label>}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !configured || !scriptOk || !remoteOk || !costOk || (preview.warnings.length > 0 && !unknownOk) || !maxCost || !Number.isFinite(Number(maxCost)) || Number(maxCost) < preview.totalReservationUsd} onClick={async () => {
          const workflow = await post<RobustnessWorkflow>(`${preview.id}/approve`, { digest: preview.digest, approveRemote: remoteOk, reviewedScript: scriptOk, acknowledgeEstimates: costOk, acknowledgeUnverifiedPlanData: unknownOk, maxEstimatedUsd: Number(maxCost) });
          if (workflow) { setHistory((old) => [workflow, ...old.filter((w) => w.preview.id !== workflow.preview.id)]); setPreview(null); setMode("history"); }
        }}>Approve and submit batch</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPreview(null); setMode("edit"); }}>Back to editing</Button></div>
      </div>}
    </DialogContent></Dialog>
  </>;
}
