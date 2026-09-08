"use client";
import { memorySourceKey } from "@/lib/notebook-memory";
import type { NextExperimentBinding } from "@/lib/next-experiments";
import { API_BASE } from "@/lib/projects";
import { orderedExperiments, resolveExperimentSource, NEXT_EXPERIMENT_NOTICE, type NextExperimentPlan, type ExperimentSourceRef } from "@/lib/next-experiments";
function Sources({ refs, projectId, sessionId, sourceDigests }: { refs: ExperimentSourceRef[]; projectId: string; sessionId: string; sourceDigests?: NextExperimentBinding["sourceDigests"] }) {
  return <span className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">{refs.map((ref, i) => {
    const source = resolveExperimentSource(ref, sessionId);
    const digest = sourceDigests?.find((s) => memorySourceKey(s.source) === memorySourceKey(source))?.digest;
    const url = `${API_BASE.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/notebook/memory/record?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(JSON.stringify(source))}${digest ? `&expectedDigest=${digest}` : ""}`;
    return <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted" title={JSON.stringify(source)}>Read source {i + 1} · {source.kind}</a>;
  })}</span>;
}
export function NextExperimentCards({ plan, projectId, sessionId, actions, sourceDigests }: {
  plan: NextExperimentPlan; projectId: string; sessionId: string; sourceDigests?: NextExperimentBinding["sourceDigests"];
  actions?: (candidate: NextExperimentPlan["experiments"][number]) => React.ReactNode;
}) {
  return <div className="space-y-3 [overflow-wrap:anywhere]">
    <p className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs">{NEXT_EXPERIMENT_NOTICE}</p>
    <p className="text-sm font-semibold">{plan.question}</p>
    <p className="text-xs"><strong>Decision to inform:</strong> {plan.decision}</p>
    <p className="text-xs"><strong>Existing-data assessment:</strong> {plan.existingDataAssessment}</p>
    <div className="grid gap-2 sm:grid-cols-2">{plan.explanations.map((e) => <section key={e.id} className="space-y-1 rounded border p-2 text-xs"><h4 className="font-semibold">Competing explanation: {e.label}</h4><p>{e.description}</p><Sources refs={e.sources} projectId={projectId} sessionId={sessionId} sourceDigests={sourceDigests} /></section>)}</div>
    <p className="text-[11px] text-muted-foreground">Suggested order is qualitative. Prerequisites appear before follow-ups; equal priorities prefer existing-data checks. These are planning judgments, not computed information gain.</p>
    {orderedExperiments(plan).map((e) => <section key={e.id} className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{e.title}</h4><span className="rounded border px-1.5 py-0.5 text-[10px]">{e.priority} · qualitative</span><span className="rounded border px-1.5 py-0.5 text-[10px]">{e.kind}</span></div>
      <p className="text-xs">{e.rationale}</p>
      {e.dependsOn.length > 0 && <p className="text-xs"><strong>Prerequisites:</strong> {e.dependsOn.map((id) => plan.experiments.find((p) => p.id === id)?.title ?? id).join("; ")}</p>}
      <p className="text-xs"><strong>Proposed method:</strong> {e.method}</p><p className="text-xs"><strong>Measurement:</strong> {e.measurement}</p>
      <div className="text-xs"><strong>Controls</strong><ul className="list-disc pl-4">{e.controls.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
      <div className="overflow-x-auto rounded border"><table className="w-full min-w-[440px] text-left text-xs"><thead><tr className="border-b bg-muted/30"><th className="p-2">If this explanation were true…</th><th className="p-2">Predicted outcome — not observed evidence</th></tr></thead><tbody>{e.predictions.map((p) => <tr key={p.explanationId} className="border-b last:border-0"><td className="p-2 align-top">{plan.explanations.find((x) => x.id === p.explanationId)?.label ?? p.explanationId}</td><td className="p-2">{p.expectedOutcome}</td></tr>)}</tbody></table></div>
      <div className="overflow-x-auto rounded border"><table className="w-full min-w-[440px] text-left text-xs"><thead><tr className="border-b bg-muted/30"><th className="p-2">If subsequently observed…</th><th className="p-2">Decision consequence</th></tr></thead><tbody>{e.decisionBranches.map((b, i) => <tr key={i} className="border-b last:border-0"><td className="p-2 align-top">{b.outcome}</td><td className="p-2">{b.decisionChange}</td></tr>)}</tbody></table></div>
      <p className="text-xs"><strong>If inconclusive:</strong> {e.inconclusiveAction}</p>
      <div className="text-xs"><strong>Required inputs (availability not verified)</strong><ul className="list-disc pl-4">{e.requiredInputs.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
      <p className="text-xs"><strong>Resources:</strong> {e.resources}</p>
      <div className="grid gap-2 text-xs sm:grid-cols-2"><p><strong>Time / effort: {e.time.level}</strong><br />{e.time.rationale}</p><p><strong>Cost / effort: {e.cost.level} (not a quote)</strong><br />{e.cost.rationale}</p></div>
      {e.whyNewData && <p className="rounded border border-amber-500/30 p-2 text-xs"><strong>Why new data are necessary:</strong> {e.whyNewData}</p>}
      <div className="text-xs"><strong>What this would not establish / limitations</strong><ul className="list-disc pl-4">{e.limitations.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
      <Sources refs={e.sources} projectId={projectId} sessionId={sessionId} sourceDigests={sourceDigests} />
      {actions?.(e)}
    </section>)}
  </div>;
}
