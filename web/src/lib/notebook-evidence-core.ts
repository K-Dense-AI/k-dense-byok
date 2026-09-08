/**
 * Pure notebook evidence semantics shared by the API, UI and exports. No IO,
 * framework imports or browser globals. Kept under web's Turbopack root; the
 * backend imports this module directly (like the shared model catalogue).
 */
export type EvidenceRelation = "supports" | "challenges" | "inconclusive" | "context";
export interface NotebookEvidenceLink {
  entryId: string;
  /** Omitted means the source entry's session, never an arbitrary matching id. */
  sessionId?: string;
  relation: EvidenceRelation;
  rationale?: string;
}
export type NotebookOutcome = "signal" | "null" | "inconclusive" | "technical-failure";
export interface NotebookArtifactSnapshot {
  path: string;
  capturedAt: number;
  timing: "entry" | "harvest" | "output";
  sha256?: string;
  size?: number;
  reason?: "missing" | "unsafe-path" | "unreadable" | "budget" | "changed-during-check";
}
export interface NotebookArtifactHealth {
  path: string;
  status: "unchanged" | "changed" | "missing" | "unverified";
  reason?: string;
  checkedAt: number;
}
export interface EvidenceEntry {
  id: string;
  sessionId?: string;
  timestamp: number;
  type: string;
  title: string;
  relatesTo?: string;
  stance?: "supports" | "refutes" | "neutral";
  supersedes?: string;
  evidence?: NotebookEvidenceLink[];
  limitations?: string[];
  outcome?: NotebookOutcome;
  artifactHealth?: NotebookArtifactHealth[];
  artifactHealthTruncated?: number;
  provisional?: boolean;
  proposalOnly?: boolean;
  nextExperiments?: unknown;
  nextExperimentDecision?: unknown;
}
export type HypothesisStatus = "open" | "supported" | "refuted" | "mixed" | "inconclusive";
export const HYPOTHESIS_LABELS: Record<HypothesisStatus, string> = {
  open: "Awaiting evidence", supported: "Supporting evidence", refuted: "Challenging evidence",
  mixed: "Conflicting evidence", inconclusive: "Inconclusive",
};
export interface ThreadInfo {
  status?: HypothesisStatus;
  supersededBy?: string;
  incoming?: { id: string; stance: "supports" | "refutes" | "neutral"; relation: EvidenceRelation }[];
  /** Active evidence only. Historical links remain in incoming for inspection. */
  activeEvidence?: { id: string; relation: EvidenceRelation }[];
  reviewRequired?: boolean;
  unverifiedArtifacts?: number;
  unresolvedLinks?: number;
  pendingEvidence?: number;
}

/** Raw ids remain unchanged in session views; project keys cannot collide. */
export function notebookEntryKey(entry: { id: string; sessionId?: string }): string {
  return entry.sessionId === undefined ? entry.id : JSON.stringify([entry.sessionId, entry.id]);
}
export function notebookTargetKey(entry: { sessionId?: string }, id: string, sessionId?: string): string {
  return notebookEntryKey({ id, sessionId: sessionId ?? entry.sessionId });
}

/** Defensive parsing for old files and provisional tool frames. */
export function normalizeEvidenceLinks(value: unknown): NotebookEvidenceLink[] {
  if (!Array.isArray(value)) return [];
  const links: NotebookEvidenceLink[] = [];
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.entryId !== "string" || !r.entryId.trim() || r.entryId.length > 500) continue;
    if (!["supports", "challenges", "inconclusive", "context"].includes(String(r.relation))) continue;
    if (r.sessionId !== undefined && (typeof r.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(r.sessionId))) continue;
    links.push({
      entryId: r.entryId.trim(), relation: r.relation as EvidenceRelation,
      ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
      ...(typeof r.rationale === "string" ? { rationale: r.rationale.slice(0, 2000) } : {}),
    });
  }
  return links;
}
export function evidenceLinks(entry: EvidenceEntry): NotebookEvidenceLink[] {
  const links = normalizeEvidenceLinks(entry.evidence);
  if (entry.relatesTo) links.push({ entryId: entry.relatesTo, relation: entry.stance === "supports" ? "supports" : entry.stance === "refutes" ? "challenges" : "context" });
  // Dedupe by target AND relation. Conflicting authored links remain visible.
  const unique = new Map<string, NotebookEvidenceLink>();
  for (const authored of links) {
    const link = entry.proposalOnly || entry.nextExperiments || entry.nextExperimentDecision ? { ...authored, relation: "context" as const } : authored;
    unique.set(JSON.stringify([notebookTargetKey(entry, link.entryId, link.sessionId), link.relation]), link);
  }
  return [...unique.values()];
}

/**
 * Summarize authored evidence, NOT scientific truth. No votes, confidence
 * arithmetic or last-entry-wins verdicts. Amendments retire old evidence but
 * never silently inherit its links. Missing targets and cycles cannot redirect
 * evidence into another chat.
 */
export function deriveEvidenceThreads(entries: readonly EvidenceEntry[]): Map<string, ThreadInfo> {
  // Stable sort preserves append order for same-millisecond corrections.
  // Arbitrary tool ids must not decide whether an amendment is later.
  const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const byKey = new Map(ordered.map((e) => [notebookEntryKey(e), e]));
  const rank = new Map(ordered.map((e, i) => [notebookEntryKey(e), i]));
  const threads = new Map<string, ThreadInfo>();
  const info = (key: string): ThreadInfo => {
    let t = threads.get(key);
    if (!t) { t = {}; threads.set(key, t); }
    return t;
  };
  for (const e of ordered) {
    const key = notebookEntryKey(e);
    if (!e.supersedes || e.provisional) continue;
    const target = notebookTargetKey(e, e.supersedes);
    // Planning proposals/preferences cannot retire actual scientific evidence.
    const prior = byKey.get(target);
    if ((e.proposalOnly || e.nextExperiments || e.nextExperimentDecision) && prior && !(prior.proposalOnly || prior.nextExperiments || prior.nextExperimentDecision)) {
      info(key).unresolvedLinks = (info(key).unresolvedLinks ?? 0) + 1;
      continue;
    }
    // Only later records may supersede earlier ones. This also rejects cycles.
    if (byKey.has(target) && rank.get(target)! < rank.get(key)!) info(target).supersededBy = key;
    else info(key).unresolvedLinks = (info(key).unresolvedLinks ?? 0) + 1;
  }
  for (const e of ordered) {
    const key = notebookEntryKey(e);
    for (const link of evidenceLinks(e)) {
      const target = notebookTargetKey(e, link.entryId, link.sessionId);
      if (target === key || !byKey.has(target)) {
        info(key).unresolvedLinks = (info(key).unresolvedLinks ?? 0) + 1;
        continue;
      }
      const relation = e.proposalOnly || e.nextExperiments || e.nextExperimentDecision ? "context" : e.outcome === "technical-failure" ? "context" : e.outcome === "inconclusive" && link.relation !== "context" ? "inconclusive" : link.relation;
      const t = info(target);
      (t.incoming ??= []).push({ id: key, relation, stance: relation === "supports" ? "supports" : relation === "challenges" ? "refutes" : "neutral" });
      if (e.provisional) t.pendingEvidence = (t.pendingEvidence ?? 0) + 1;
      else if (!info(key).supersededBy) (t.activeEvidence ??= []).push({ id: key, relation });
    }
  }
  for (const e of ordered) {
    const key = notebookEntryKey(e);
    const t = info(key);
    const active = t.activeEvidence ?? [];
    if (e.type === "hypothesis") {
      const supports = active.some((x) => x.relation === "supports");
      const challenges = active.some((x) => x.relation === "challenges");
      t.status = supports && challenges ? "mixed" : supports ? "supported" : challenges ? "refuted" : active.some((x) => x.relation === "inconclusive") ? "inconclusive" : "open";
    }
    // Only direct evidence edges, not an unbounded transitive truth graph.
    const sources = [e, ...new Set(active.filter((x) => x.relation !== "context").map((x) => byKey.get(x.id)!))];
    const health = sources.flatMap((source) => source.artifactHealth ?? []);
    t.reviewRequired = health.some((a) => a.status === "changed" || a.status === "missing");
    t.unverifiedArtifacts = health.filter((a) => a.status === "unverified").length
      + sources.reduce((count, source) => count + (source.artifactHealthTruncated ?? 0), 0);
  }
  return threads;
}
