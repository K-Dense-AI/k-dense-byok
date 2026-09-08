/** IO-free next-investigation protocol. Predictions and preferences are not evidence or permission. */
import type { MemorySource, MemoryHit, MemoryCoverage } from "./notebook-memory";
import type { NotebookArtifactSnapshot } from "./notebook-evidence-core";
export interface ExperimentSourceRef {
  kind?: "notebook" | "user-note" | "plan-event";
  sessionId?: string;
  entryId: string;
  eventId?: string;
}
export interface ExperimentTarget { sessionId?: string; entryId: string }
export type ExperimentPriority = "first" | "next" | "later";
export type EffortLevel = "low" | "medium" | "high" | "unknown";
export interface NextExperimentPlan {
  target: ExperimentTarget;
  question: string;
  decision: string;
  existingDataAssessment: string;
  explanations: { id: string; label: string; description: string; sources: ExperimentSourceRef[] }[];
  experiments: {
    id: string;
    title: string;
    kind: "existing-data" | "new-data" | "literature-check";
    priority: ExperimentPriority;
    rationale: string;
    sources: ExperimentSourceRef[];
    dependsOn: string[];
    method: string;
    measurement: string;
    controls: string[];
    predictions: { explanationId: string; expectedOutcome: string }[];
    decisionBranches: { outcome: string; decisionChange: string }[];
    inconclusiveAction: string;
    requiredInputs: string[];
    resources: string;
    time: { level: EffortLevel; rationale: string };
    cost: { level: EffortLevel; rationale: string };
    limitations: string[];
    whyNewData?: string;
  }[];
}
export interface NextExperimentContext {
  projectId: string;
  source: { sessionId: string; entryId: string };
  digest: string;
  capturedAt: number;
  targetStatus: "active" | "superseded" | "unknown";
  sources: { hit: MemoryHit; text: string; textTruncated: boolean }[];
  artifacts: Omit<NotebookArtifactSnapshot, "timing">[];
  artifactsOmitted: number;
  coverage: MemoryCoverage;
  warnings: string[];
}
export interface NextExperimentBinding {
  kind: "proposal-context";
  capturedAt: number;
  contextDigest?: string;
  /** Planning-time file identities, not historical bytes or citation-time proof. */
  artifacts?: NextExperimentContext["artifacts"];
  artifactsOmitted?: number;
  sourceDigests: { source: MemorySource; digest?: string }[];
  origin: "agent-authored" | "model-generated" | "harvested";
  contextChangedDuringGeneration?: boolean | "unknown";
  generation?: { requestId: string; requestDigest: string; model: string; costUsd: number; billingMode?: string };
}
export interface NextExperimentChoice {
  proposal: { sessionId: string; entryId: string; digest: string };
  candidateId: string;
  disposition: "prioritize" | "defer" | "reject";
  reason: string;
  contextDigest: string;
  proposalContextStatus: "current" | "changed" | "unverified";
  requestDigest: string;
}
export interface NextExperimentProposalView {
  source: { sessionId: string; entryId: string };
  digest: string;
  timestamp: number;
  author: string;
  status: "active" | "superseded" | "unknown";
  plan: NextExperimentPlan;
  binding?: NextExperimentBinding;
  contextStatus: "current" | "changed" | "unverified";
  decisions: { id: string; timestamp: number; choice: NextExperimentChoice }[];
}
export interface NextExperimentView {
  context: NextExperimentContext;
  proposals: NextExperimentProposalView[];
  warnings: string[];
}
export const NEXT_EXPERIMENT_NOTICE = "Proposed investigations, not observed findings, validated predictions, execution approvals or spending commitments. Priorities, information value, time and cost are qualitative author judgments—not computed probabilities, calibrated confidence, Bayesian information gain or provider quotes. Review sources, controls, feasibility and ethics before making a current analysis plan.";
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
export const NEXT_EXPERIMENT_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const member = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
function object(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${name} must be an object`);
  return raw as Record<string, unknown>;
}
function text(raw: unknown, name: string, max = 1600): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max) throw new Error(`${name} is required (maximum ${max} characters)`);
  return raw.trim();
}
function list(raw: unknown, name: string, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) throw new Error(`${name} must contain ${min}–${max} items`);
  return raw;
}
function sourceRef(raw: unknown): ExperimentSourceRef {
  const r = object(raw, "source");
  if (r.projectId !== undefined) throw new Error("Source refs are scoped to the current project; projectId is not a supported source field");
  const entryId = text(r.entryId, "source entryId", 500);
  if (entryId.includes("\0")) throw new Error("Invalid source entryId");
  if (r.sessionId !== undefined && (typeof r.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(r.sessionId))) throw new Error("Invalid source sessionId");
  const kind = r.kind === undefined ? "notebook" : r.kind;
  if (!member(kind, ["notebook", "user-note", "plan-event"])) throw new Error("Invalid source kind");
  const eventId = kind === "plan-event" ? text(r.eventId, "source eventId", 100) : undefined;
  return { kind: kind as ExperimentSourceRef["kind"], entryId, ...(r.sessionId ? { sessionId: r.sessionId as string } : {}), ...(eventId ? { eventId } : {}) };
}
export function resolveExperimentSource(ref: ExperimentSourceRef, sessionId: string): MemorySource {
  return { kind: ref.kind ?? "notebook", sessionId: ref.sessionId ?? sessionId, entryId: ref.entryId, ...(ref.eventId ? { eventId: ref.eventId } : {}) };
}
export function experimentSources(plan: NextExperimentPlan): ExperimentSourceRef[] {
  const refs: ExperimentSourceRef[] = [{ kind: "notebook", ...plan.target }, ...plan.explanations.flatMap((e) => e.sources), ...plan.experiments.flatMap((e) => e.sources)];
  return [...new Map(refs.map((r) => [JSON.stringify(r), r])).values()];
}
export function normalizeNextExperiments(input: unknown): NextExperimentPlan {
  const raw = object(input, "nextExperiments");
  const target = object(raw.target, "target");
  if (target.kind !== undefined && target.kind !== "notebook") throw new Error("Proposal target must be a notebook hypothesis");
  const targetRef = sourceRef({ ...target, kind: "notebook" });
  const seen = new Set<string>();
  const sources = (v: unknown) => list(v, "sources", 1, 6).map(sourceRef);
  const explanations = list(raw.explanations, "competing explanations", 2, 4).map((v) => {
    const e = object(v, "explanation"); const id = text(e.id, "explanation id", 40);
    if (!ID.test(id) || seen.has(id)) throw new Error("Explanation ids must be unique lowercase identifiers"); seen.add(id);
    return { id, label: text(e.label, "explanation label", 200), description: text(e.description, "explanation description"), sources: sources(e.sources) };
  });
  const explanationIds = new Set(explanations.map((e) => e.id)); const candidates = new Set<string>();
  const effort = (v: unknown, name: string) => { const r = object(v, name); if (!member(r.level, ["low", "medium", "high", "unknown"])) throw new Error(`${name} must use a qualitative level`); return { level: r.level as EffortLevel, rationale: text(r.rationale, `${name} rationale`, 1000) }; };
  const strings = (v: unknown, name: string, min = 1) => list(v, name, min, 8).map((s) => text(s, name, 1000));
  const experiments = list(raw.experiments, "experiments", 1, 6).map((v) => {
    const e = object(v, "experiment"); const id = text(e.id, "experiment id", 40);
    if (!ID.test(id) || candidates.has(id)) throw new Error("Experiment ids must be unique lowercase identifiers"); candidates.add(id);
    if (!member(e.kind, ["existing-data", "new-data", "literature-check"])) throw new Error("Invalid investigation kind");
    if (!member(e.priority, ["first", "next", "later"])) throw new Error("Priority must be first, next or later");
    const predictions = list(e.predictions, "predictions", explanations.length, explanations.length).map((v) => {
      const p = object(v, "prediction"); const explanationId = text(p.explanationId, "prediction explanation id", 40);
      if (!explanationIds.has(explanationId)) throw new Error("Prediction targets an unknown explanation");
      return { explanationId, expectedOutcome: text(p.expectedOutcome, "predicted outcome") };
    });
    if (new Set(predictions.map((p) => p.explanationId)).size !== explanations.length) throw new Error("Each test must predict an outcome under every competing explanation exactly once");
    return { id, title: text(e.title, "experiment title", 200), kind: e.kind as NextExperimentPlan["experiments"][number]["kind"], priority: e.priority as ExperimentPriority,
      rationale: text(e.rationale, "priority rationale"), sources: sources(e.sources), dependsOn: strings(e.dependsOn ?? [], "dependencies", 0),
      method: text(e.method, "proposed method"), measurement: text(e.measurement, "primary measurement"), controls: strings(e.controls, "controls"), predictions,
      decisionBranches: list(e.decisionBranches, "decision branches", 2, 4).map((v) => { const b = object(v, "decision branch"); return { outcome: text(b.outcome, "possible observed outcome"), decisionChange: text(b.decisionChange, "decision consequence") }; }),
      inconclusiveAction: text(e.inconclusiveAction, "inconclusive-result action"), requiredInputs: strings(e.requiredInputs, "required inputs"), resources: text(e.resources, "resource requirements"),
      time: effort(e.time, "time"), cost: effort(e.cost, "cost"), limitations: strings(e.limitations, "limitations"),
      ...(e.kind === "new-data" ? { whyNewData: text(e.whyNewData, "why existing data cannot answer this") } : {}),
    };
  });
  for (const e of experiments) if (new Set(e.dependsOn).size !== e.dependsOn.length || e.dependsOn.some((id) => !candidates.has(id) || id === e.id)) throw new Error("Dependencies must reference distinct other experiments");
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error("Experiment dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of experiments.find((e) => e.id === id)!.dependsOn) visit(dep); visiting.delete(id); visited.add(id); };
  for (const e of experiments) visit(e.id);
  return { target: { entryId: targetRef.entryId, ...(targetRef.sessionId ? { sessionId: targetRef.sessionId } : {}) }, question: text(raw.question, "research question"), decision: text(raw.decision, "decision to inform"), existingDataAssessment: text(raw.existingDataAssessment, "existing-data assessment", 2400), explanations, experiments };
}
/** Defensive readers for server metadata in older/edited notebook files. Invalid
 * metadata must degrade to unverified, not crash or become approval. */
export function readExperimentBinding(value: unknown): NextExperimentBinding | undefined {
  try {
    const r = object(value, "binding");
    if (r.kind !== "proposal-context" || !member(r.origin, ["agent-authored", "model-generated", "harvested"]) || typeof r.capturedAt !== "number" || !Number.isFinite(r.capturedAt)) return;
    const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    if (r.contextDigest !== undefined && !digest(r.contextDigest)) return;
    const sourceDigests = list(r.sourceDigests, "source bindings", 0, 64).map((v) => {
      const s = object(v, "source binding"); const source = sourceRef(s.source);
      if (!source.sessionId || s.digest !== undefined && !digest(s.digest)) throw new Error("Invalid source binding");
      return { source: resolveExperimentSource(source, source.sessionId), ...(s.digest ? { digest: s.digest as string } : {}) };
    });
    let artifacts: NextExperimentBinding["artifacts"];
    if (r.artifacts !== undefined) artifacts = list(r.artifacts, "planning file identities", 0, 25).map((value) => {
      const a = object(value, "planning file identity");
      if (typeof a.capturedAt !== "number" || !Number.isFinite(a.capturedAt) || a.sha256 !== undefined && !digest(a.sha256) || a.size !== undefined && (typeof a.size !== "number" || !Number.isFinite(a.size) || a.size < 0) || a.reason !== undefined && !member(a.reason, ["missing", "unsafe-path", "unreadable", "budget", "changed-during-check"])) throw new Error("Invalid planning file identity");
      return { path: text(a.path, "file path", 1000), capturedAt: a.capturedAt, ...(a.sha256 ? { sha256: a.sha256 as string } : {}), ...(typeof a.size === "number" ? { size: a.size } : {}), ...(a.reason ? { reason: a.reason as NonNullable<NextExperimentBinding["artifacts"]>[number]["reason"] } : {}) };
    });
    let generation: NextExperimentBinding["generation"];
    if (r.generation !== undefined) {
      const g = object(r.generation, "generation");
      if (typeof g.requestId !== "string" || !NEXT_EXPERIMENT_REQUEST_ID.test(g.requestId) || !digest(g.requestDigest) || typeof g.costUsd !== "number" || !Number.isFinite(g.costUsd) || g.costUsd < 0) return;
      generation = { requestId: g.requestId, requestDigest: g.requestDigest as string, model: text(g.model, "model", 500), costUsd: g.costUsd, ...(typeof g.billingMode === "string" ? { billingMode: g.billingMode.slice(0, 30) } : {}) };
    }
    if (r.origin === "model-generated" && (!r.contextDigest || !generation)) return;
    return { kind: "proposal-context", origin: r.origin as NextExperimentBinding["origin"], capturedAt: r.capturedAt, sourceDigests, ...(artifacts ? { artifacts } : {}), ...(typeof r.artifactsOmitted === "number" && r.artifactsOmitted >= 0 ? { artifactsOmitted: r.artifactsOmitted } : {}),
      ...(r.contextDigest ? { contextDigest: r.contextDigest as string } : {}), ...(generation ? { generation } : {}),
      ...(typeof r.contextChangedDuringGeneration === "boolean" || r.contextChangedDuringGeneration === "unknown" ? { contextChangedDuringGeneration: r.contextChangedDuringGeneration } : {}) };
  } catch { return; }
}
export function readExperimentChoice(value: unknown): NextExperimentChoice | undefined {
  try {
    const r = object(value, "choice"), p = object(r.proposal, "proposal"); const source = sourceRef({ ...p, kind: "notebook" });
    if (!source.sessionId || ![p.digest, r.contextDigest, r.requestDigest].every((d) => typeof d === "string" && /^[a-f0-9]{64}$/.test(d)) || typeof r.candidateId !== "string" || !ID.test(r.candidateId) || !member(r.disposition, ["prioritize", "defer", "reject"]) || !member(r.proposalContextStatus, ["current", "changed", "unverified"])) return;
    return { proposal: { sessionId: source.sessionId, entryId: source.entryId, digest: p.digest as string }, candidateId: r.candidateId as string, disposition: r.disposition as NextExperimentChoice["disposition"], reason: text(r.reason, "reason", 2000), contextDigest: r.contextDigest as string, proposalContextStatus: r.proposalContextStatus as NextExperimentChoice["proposalContextStatus"], requestDigest: r.requestDigest as string };
  } catch { return; }
}
/** Suggested display order only. Dependencies precede follow-ups; equal priorities prefer existing data. */
export function orderedExperiments(plan: NextExperimentPlan): NextExperimentPlan["experiments"] {
  const priorities = { first: 0, next: 1, later: 2 }; const kinds = { "existing-data": 0, "literature-check": 1, "new-data": 2 };
  const sorted = [...plan.experiments].sort((a, b) => priorities[a.priority] - priorities[b.priority] || kinds[a.kind] - kinds[b.kind]);
  const out: NextExperimentPlan["experiments"] = []; const done = new Set<string>();
  const add = (e: NextExperimentPlan["experiments"][number]) => { if (done.has(e.id)) return; done.add(e.id); for (const dep of e.dependsOn) { const target = plan.experiments.find((x) => x.id === dep); if (target) add(target); } out.push(e); };
  for (const e of sorted) add(e); return out;
}
export function nextExperimentsText(plan: NextExperimentPlan): string {
  return ["# Proposed next investigations", NEXT_EXPERIMENT_NOTICE, `Target hypothesis: ${JSON.stringify(plan.target)} (omitted source sessions default to the proposal's session)`, `Question: ${plan.question}`, `Decision to inform: ${plan.decision}`, `Existing-data assessment: ${plan.existingDataAssessment}`,
    ...plan.explanations.map((e) => `Explanation ${e.id}: ${e.label}\n${e.description}\nSources: ${JSON.stringify(e.sources)}`),
    ...orderedExperiments(plan).map((e) => [
      `## ${e.title} (${e.id})`, `Priority: ${e.priority} (qualitative); kind: ${e.kind}; prerequisites: ${e.dependsOn.join(", ") || "none declared"}`, `Rationale: ${e.rationale}`, `Proposed method: ${e.method}`, `Measurement: ${e.measurement}`, `Controls: ${e.controls.join("; ")}`,
      ...e.predictions.map((p) => `PREDICTED under ${p.explanationId}: ${p.expectedOutcome}`), ...e.decisionBranches.map((b) => `IF observed: ${b.outcome}\nTHEN reconsider decision: ${b.decisionChange}`),
      `If inconclusive: ${e.inconclusiveAction}`, `Required inputs (not verified available): ${e.requiredInputs.join("; ")}`, `Resources: ${e.resources}`, `Time: ${e.time.level} — ${e.time.rationale}`, `Cost: ${e.cost.level} — ${e.cost.rationale} (not a quote)`,
      e.whyNewData ? `Why new data: ${e.whyNewData}` : "", `Limitations: ${e.limitations.join("; ")}`, `Sources: ${JSON.stringify(e.sources)}`,
    ].filter(Boolean).join("\n\n")),
  ].join("\n\n");
}
