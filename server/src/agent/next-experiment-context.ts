/** Bounded observed/authored source context for proposals; no generation or execution. */
import { loadMemoryCorpus, type MemoryCorpus, type MemoryDocument } from "./notebook-memory-loader.ts";
import { hitsFor } from "./notebook-memory.ts";
import { captureNotebookArtifacts } from "./notebook-artifacts.ts";
import { deriveEvidenceThreads, evidenceLinks, notebookEntryKey, notebookTargetKey } from "../../../web/src/lib/notebook-evidence-core.ts";
import { memorySourceKey, rankMemory } from "../../../web/src/lib/notebook-memory.ts";
import { experimentSources, resolveExperimentSource, type NextExperimentPlan, type NextExperimentContext, type NextExperimentBinding } from "../../../web/src/lib/next-experiments.ts";
import { validatePlanSource } from "./notebook-plans.ts";
import { jsonDigest } from "../canonical-json.ts";
import { SandboxError } from "../sandbox-fs.ts";

export interface ExperimentContextBuild { context: NextExperimentContext; corpus: MemoryCorpus }
export async function buildNextExperimentContext(projectId: string, source: { sessionId: string; entryId: string }, options: { allowHistorical?: boolean } = {}): Promise<ExperimentContextBuild> {
  validatePlanSource(source);
  const corpus = await loadMemoryCorpus(projectId, { kind: "notebook", ...source }, { retainOriginal: true });
  const root = corpus.documents.find((d) => d.source.kind === "notebook" && d.source.sessionId === source.sessionId && d.source.entryId === source.entryId);
  if (!root || root.entry.type !== "hypothesis" || root.entry.proposalOnly) throw new SandboxError(404, "Select one saved scientific hypothesis; its source may be outside the bounded scan");
  // Prior proposals and preferences are not new evidence and must not cause
  // self-invalidation or become a feedback loop in subsequent generations.
  const scientific: MemoryCorpus = { ...corpus, documents: corpus.documents.filter((d) => !d.entry.proposalOnly) };
  const notebook = scientific.documents.filter((d) => d.source.kind === "notebook");
  const key = (d: MemoryDocument) => notebookEntryKey({ id: d.source.entryId, sessionId: d.source.sessionId });
  const rootKey = key(root);
  const threads = deriveEvidenceThreads(notebook.map((d) => ({ ...d.entry, sessionId: d.source.sessionId })));
  const targetStatus = threads.get(rootKey)?.supersededBy ? "superseded" : corpus.coverage.complete ? "active" : "unknown";
  if (targetStatus === "superseded" && !options.allowHistorical) throw new SandboxError(409, "This hypothesis was superseded; propose next tests for its amended version");
  const byKey = new Map(notebook.map((d) => [key(d), d]));
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { for (const [x, y] of [[a, b], [b, a]]) { const set = adjacent.get(x) ?? new Set<string>(); set.add(y); adjacent.set(x, set); } };
  for (const d of notebook) {
    for (const r of evidenceLinks(d.entry)) link(key(d), notebookTargetKey({ sessionId: d.source.sessionId }, r.entryId, r.sessionId));
    if (d.entry.supersedes) link(key(d), notebookTargetKey({ sessionId: d.source.sessionId }, d.entry.supersedes));
  }
  const selected = new Map<string, MemoryDocument>([[memorySourceKey(root.source), root]]);
  const queue = [{ key: rootKey, depth: 0 }]; const visited = new Set<string>();
  const warnings = [...corpus.coverage.warnings];
  if (targetStatus === "superseded") warnings.push("Target hypothesis was superseded; this is historical proposal context, not a current planning target.");
  while (queue.length) {
    const item = queue.shift()!; if (visited.has(item.key)) continue; visited.add(item.key);
    const d = byKey.get(item.key);
    if (!d) { warnings.push("Some linked notebook evidence is unavailable in the recalled context."); continue; }
    if (selected.size >= 18 && !selected.has(memorySourceKey(d.source))) { warnings.push("Direct evidence context was bounded; omitted links are not verified absent."); continue; }
    selected.set(memorySourceKey(d.source), d);
    if (item.depth < 2) for (const next of [...(adjacent.get(item.key) ?? [])].sort()) queue.push({ key: next, depth: item.depth + 1 });
  }
  const planEvents = scientific.documents.filter((d) => d.source.kind === "plan-event" && d.source.sessionId === source.sessionId && d.source.entryId === source.entryId).sort((a, b) => b.entry.timestamp - a.entry.timestamp || memorySourceKey(a.source).localeCompare(memorySourceKey(b.source)));
  // Keep the current frozen plan even when many newer deviations exist.
  const currentPlan = planEvents.find((d) => d.type === "plan" && !d.historical);
  const chosenPlans = [...(currentPlan ? [currentPlan] : []), ...planEvents.filter((d) => d !== currentPlan)].slice(0, 4);
  for (const d of chosenPlans) selected.set(memorySourceKey(d.source), d);
  if (planEvents.length > chosenPlans.length) warnings.push("Only the current frozen plan and three other plan/deviation records were selected; inspect the full validated plan history before acting.");
  const ranked = rankMemory(scientific.documents.filter((d) => !selected.has(memorySourceKey(d.source)) && !planEvents.includes(d)), `${root.entry.title} ${root.entry.scope ?? ""}`);
  ranked.sort((a, b) => b.score - a.score || memorySourceKey(a.document.source).localeCompare(memorySourceKey(b.document.source)));
  for (const r of ranked) { if (selected.size >= 24) break; selected.set(memorySourceKey(r.document.source), r.document); }
  const docs = [...selected.values()].sort((a, b) => (a === root ? -1 : b === root ? 1 : memorySourceKey(a.source).localeCompare(memorySourceKey(b.source))));
  const hits = await hitsFor(projectId, scientific, docs.map((document) => ({ document, matchedFields: [] })), root.entry.title);
  const sources = docs.map((d, i) => ({ hit: hits[i], text: d.entry.body?.slice(0, 1800) ?? "", textTruncated: (d.entry.body?.length ?? 0) > 1800 }));
  const paths = [...new Set(docs.flatMap((d) => d.entry.artifacts ?? []))].sort();
  const artifacts = (await captureNotebookArtifacts(projectId, paths)).map(({ timing: _timing, ...identity }) => identity);
  const artifactsOmitted = Math.max(0, paths.length - artifacts.length);
  if (artifactsOmitted) warnings.push("Additional source artifacts were not identity-checked within the context budget.");
  if (artifacts.some((a) => !a.sha256)) warnings.push("Some source artifact identities are unverified; availability and currentness must be checked before acting.");
  if (hits.some((h) => h.artifactHealth.some((a) => a.status === "changed" || a.status === "missing"))) warnings.push("Some cited source artifacts changed or are missing. Proposed tests require source review.");
  const stable = { projectId, source, targetStatus, records: sources.map((s) => ({ source: s.hit.source, digest: s.hit.digest })), artifacts: artifacts.map(({ capturedAt: _time, ...a }) => a), artifactsOmitted, complete: corpus.coverage.complete, warnings: [...new Set(warnings)].sort() };
  return { corpus, context: { projectId, source, digest: jsonDigest(stable), capturedAt: Date.now(), targetStatus, sources, artifacts, artifactsOmitted, coverage: corpus.coverage, warnings: stable.warnings } };
}

/** Bind a tool-authored proposal to the source versions actually found by the
 * server. Missing source ids stay unverified; no model may stamp these fields. */
export async function bindAuthoredProposal(projectId: string, sessionId: string, plan: NextExperimentPlan): Promise<NextExperimentBinding> {
  const target = { sessionId: plan.target.sessionId ?? sessionId, entryId: plan.target.entryId };
  const corpus = await loadMemoryCorpus(projectId, { kind: "notebook", ...target });
  const byKey = new Map(corpus.documents.map((d) => [memorySourceKey(d.source), d]));
  const hypothesis = byKey.get(memorySourceKey({ kind: "notebook", ...target }));
  if (!hypothesis || hypothesis.entry.type !== "hypothesis" || hypothesis.entry.proposalOnly) throw new Error("Next-experiment target must be an already saved scientific hypothesis");
  return { kind: "proposal-context", origin: "agent-authored", capturedAt: Date.now(), sourceDigests: experimentSources(plan).map((ref) => {
    const source = resolveExperimentSource(ref, sessionId); const found = byKey.get(memorySourceKey(source));
    return { source, ...(found ? { digest: found.digest } : {}) };
  }) };
}
export function proposalContextStatus(binding: NextExperimentBinding | undefined, context: NextExperimentContext, corpus: MemoryCorpus): "current" | "changed" | "unverified" {
  if (!binding || binding.origin === "harvested") return "unverified";
  if (binding.contextDigest) {
    if (binding.contextDigest !== context.digest) return "changed";
    if (!context.coverage.complete || context.artifactsOmitted || context.artifacts.some((a) => !a.sha256) || context.warnings.length) return "unverified";
    return "current";
  }
  const byKey = new Map(corpus.documents.map((d) => [memorySourceKey(d.source), d.digest]));
  if (!binding.sourceDigests?.length || binding.sourceDigests.some((s) => !s.digest || !byKey.has(memorySourceKey(s.source)))) return "unverified";
  if (binding.sourceDigests.some((s) => byKey.get(memorySourceKey(s.source)) !== s.digest)) return "changed";
  // Tool-authored proposals pin record identities, not the complete artifact context.
  return "unverified";
}
