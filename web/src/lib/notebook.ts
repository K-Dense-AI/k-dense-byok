/**
 * Lab-notebook entry model + pure helpers shared by useAgent and the view.
 *
 * A live `tool_start` frame (toolName "notebook") carries only the model-
 * supplied fields — parseNotebookFrame builds a *provisional* entry from it
 * (client timestamp). The authoritative entry (server timestamp + role) comes
 * from GET /sessions/:id/notebook; mergeNotebookEntries reconciles the two by id.
 */
import type { AgentFrame } from "./use-agent";
import { readExperimentBinding, readExperimentChoice, normalizeNextExperiments, type NextExperimentPlan, type NextExperimentBinding, type NextExperimentChoice } from "./next-experiments";
import { normalizeRobustnessDraft, type RobustnessDraft } from "./notebook-robustness";
import { normalizeAnalysisPlan, type AnalysisPlanInput, type AnalysisPlanHistory } from "./notebook-plans";
import { normalizeResultLinks, type NotebookResultLink, type NotebookResultSnapshot } from "./notebook-result-links";
import { notebookEntryKey, normalizeEvidenceLinks, type NotebookEvidenceLink, type NotebookOutcome, type NotebookArtifactHealth } from "./notebook-evidence-core";
export { notebookEntryKey, notebookTargetKey, evidenceLinks, HYPOTHESIS_LABELS } from "./notebook-evidence-core";

export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

export type NotebookStance = "supports" | "refutes" | "neutral";

export interface NotebookEntry {
  id: string;
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: { source: string; lang?: string };
  confidence?: "low" | "medium" | "high";
  tags?: string[];
  evidence?: NotebookEvidenceLink[];
  limitations?: string[];
  scope?: string;
  revisitWhen?: string;
  outcome?: NotebookOutcome;
  analysisPlan?: AnalysisPlanInput;
  robustness?: RobustnessDraft;
  nextExperiments?: NextExperimentPlan;
  nextExperimentBinding?: NextExperimentBinding;
  nextExperimentDecision?: NextExperimentChoice;
  proposalOnly?: boolean;
  planHistory?: AnalysisPlanHistory;
  planHistoryError?: string;
  results?: NotebookResultLink[];
  resultSnapshots?: NotebookResultSnapshot[];
  /** Read-time server measurement. Never accepted from provisional tool args. */
  artifactHealth?: NotebookArtifactHealth[];
  artifactHealthTruncated?: number;
  provisional?: boolean;
  timestamp: number;
  role?: string;
  /** Id of an earlier entry this one responds to (threading). */
  relatesTo?: string;
  stance?: NotebookStance;
  /** Id of an earlier entry this one amends/replaces. */
  supersedes?: string;
  /** Server-stamped id of the /run invocation (run dividers). */
  runId?: string;
  /** Present only in project-scope responses. */
  sessionId?: string;
}

function nextExperimentDraft(value: unknown): NextExperimentPlan | undefined {
  try { return normalizeNextExperiments(value); } catch { return undefined; }
}

function robustnessDraft(value: unknown): RobustnessDraft | undefined {
  try { return normalizeRobustnessDraft(value); } catch { return undefined; }
}

function planDraft(value: unknown): AnalysisPlanInput | undefined {
  try { return normalizeAnalysisPlan(value); } catch { return undefined; }
}

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

export function parseNotebookFrame(
  frame: AgentFrame,
  runId?: string,
): NotebookEntry | null {
  if (frame.type !== "tool_start" || frame.toolName !== "notebook") return null;
  const a = frame.args as Record<string, unknown> | undefined;
  if (!a || !isEntryType(a.type)) return null;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) return null;
  return {
    id: String(frame.toolCallId ?? title),
    type: a.type,
    title,
    body: typeof a.body === "string" ? a.body : undefined,
    artifacts: Array.isArray(a.artifacts) ? a.artifacts.map(String) : undefined,
    code:
      a.code && typeof (a.code as { source?: unknown }).source === "string"
        ? {
            source: String((a.code as { source: string }).source),
            lang: typeof (a.code as { lang?: unknown }).lang === "string"
              ? String((a.code as { lang: string }).lang)
              : undefined,
          }
        : undefined,
    confidence:
      a.confidence === "low" || a.confidence === "medium" || a.confidence === "high"
        ? a.confidence
        : undefined,
    tags: Array.isArray(a.tags) ? a.tags.map(String) : undefined,
    relatesTo:
      typeof a.relatesTo === "string" && a.relatesTo.trim() ? a.relatesTo.trim() : undefined,
    stance:
      a.stance === "supports" || a.stance === "refutes" || a.stance === "neutral"
        ? a.stance
        : undefined,
    supersedes:
      typeof a.supersedes === "string" && a.supersedes.trim() ? a.supersedes.trim() : undefined,
    evidence: normalizeEvidenceLinks(a.evidence),
    analysisPlan: planDraft(a.analysisPlan),
    robustness: robustnessDraft(a.robustness),
    nextExperiments: nextExperimentDraft(a.nextExperiments),
    ...(a.nextExperiments ? { proposalOnly: true } : {}),
    results: normalizeResultLinks(a.results),
    scope: typeof a.scope === "string" ? a.scope.slice(0, 2000) : undefined,
    revisitWhen: typeof a.revisitWhen === "string" ? a.revisitWhen.slice(0, 2000) : undefined,
    limitations: Array.isArray(a.limitations) ? a.limitations.filter((x): x is string => typeof x === "string").slice(0, 16) : undefined,
    outcome: a.outcome === "signal" || a.outcome === "null" || a.outcome === "inconclusive" || a.outcome === "technical-failure" ? a.outcome : undefined,
    timestamp: Date.now(),
    provisional: true,
    // Provisional stamp from the run_start frame; the authoritative refetch
    // (server-stamped runId) wins on merge.
    ...(runId ? { runId } : {}),
  };
}

/**
 * Coerce server-fetched entries into the shape the views assume.
 *
 * Rows come from an append-only JSONL file that a user (or a future schema)
 * can put an unrecognized `type` into. The views index `TYPE_META` by type, so
 * an unknown one would render as `undefined.spine` and take down the whole
 * notebook panel; treating it as a plain note keeps the entry visible.
 */
export function normalizeNotebookEntries(entries: readonly NotebookEntry[]): NotebookEntry[] {
  return entries.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && Number.isFinite(entry.timestamp)).map((entry) => ({
    ...entry,
    type: isEntryType(entry.type) ? entry.type : "note" as const,
    title: typeof entry.title === "string" ? entry.title : "Untitled entry",
    artifacts: Array.isArray(entry.artifacts) ? entry.artifacts.filter((p): p is string => typeof p === "string") : undefined,
    evidence: normalizeEvidenceLinks(entry.evidence),
    analysisPlan: planDraft(entry.analysisPlan),
    robustness: robustnessDraft(entry.robustness),
    nextExperiments: nextExperimentDraft(entry.nextExperiments),
    proposalOnly: Boolean(entry.proposalOnly || entry.nextExperiments || entry.nextExperimentDecision),
    nextExperimentBinding: readExperimentBinding(entry.nextExperimentBinding),
    nextExperimentDecision: readExperimentChoice(entry.nextExperimentDecision),
    results: normalizeResultLinks(entry.results, true),
    scope: typeof entry.scope === "string" ? entry.scope.slice(0, 2000) : undefined,
    revisitWhen: typeof entry.revisitWhen === "string" ? entry.revisitWhen.slice(0, 2000) : undefined,
    limitations: Array.isArray(entry.limitations) ? entry.limitations.filter((x): x is string => typeof x === "string").slice(0, 16) : undefined,
    artifactHealth: Array.isArray(entry.artifactHealth) ? entry.artifactHealth.filter((h) => h && typeof h.path === "string" && Number.isFinite(h.checkedAt) && ["unchanged", "changed", "missing", "unverified"].includes(h.status)) : undefined,
    provisional: false,
  }));
}

export function mergeNotebookEntries(
  a: NotebookEntry[],
  b: NotebookEntry[],
): NotebookEntry[] {
  const byId = new Map<string, NotebookEntry>();
  for (const e of a) byId.set(notebookEntryKey(e), e);
  for (const e of b) byId.set(notebookEntryKey(e), e); // b (authoritative) wins on conflict
  return [...byId.values()].sort((x, y) => x.timestamp - y.timestamp);
}
