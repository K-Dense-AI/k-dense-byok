/**
 * Harvest lab-notebook entries a SUBAGENT logged, out of its session JSONL.
 *
 * A child session gets the `notebook` tool from the kady-notebook package;
 * every call it makes is recorded as an assistant `toolCall` content block in
 * the child's session file. The parent (which learns each child's sessionFile
 * on completion — exactly as usageFromSessionFile harvests cost) parses those
 * calls into NotebookEntry rows, stamped with the child's agent name as `role`
 * and a namespaced id so they never collide with the lead's entries.
 *
 * Pure + defensive: unreadable file / malformed row / invalid entry are skipped.
 */
import { normalizeNextExperiments, type ExperimentSourceRef } from "../../../web/src/lib/next-experiments.ts";
import { normalizeEvidenceLinks } from "../../../web/src/lib/notebook-evidence-core.ts";
import { normalizeAnalysisPlan } from "../../../web/src/lib/notebook-plans.ts";
import { normalizeRobustnessDraft } from "../../../web/src/lib/notebook-robustness.ts";
import { normalizeResultLinks } from "../../../web/src/lib/notebook-result-links.ts";
import fs from "node:fs";
import { stripSandboxRoot } from "./events.ts";
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

/** Coerce a recorded tool-call `arguments` object into a NotebookEntry, or null. */
function entryFromArgs(
  args: Record<string, unknown>,
  id: string,
  role: string,
  timestamp: number,
  sandboxRoot: string,
): NotebookEntry | null {
  if (!isEntryType(args.type)) return null;
  if (args.nextExperiments !== undefined && args.type !== "note") return null;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  const code =
    args.code && typeof (args.code as { source?: unknown }).source === "string"
      ? {
          source: String((args.code as { source: string }).source),
          lang:
            typeof (args.code as { lang?: unknown }).lang === "string"
              ? String((args.code as { lang: string }).lang)
              : undefined,
        }
      : undefined;
  let robustness;
  if (args.robustness && args.type === "hypothesis") {
    try { robustness = normalizeRobustnessDraft(args.robustness); } catch { /* invalid proposal */ }
  }
  let analysisPlan;
  if (args.analysisPlan && args.type === "hypothesis") {
    try { analysisPlan = normalizeAnalysisPlan(args.analysisPlan); } catch { /* invalid proposals are not plans */ }
  }
  let nextExperiments;
  if (args.nextExperiments && args.type === "note") {
    try {
      const plan = normalizeNextExperiments(args.nextExperiments);
      const target = plan.target.sessionId ? plan.target : { ...plan.target, entryId: `${role}:${plan.target.entryId}` };
      const namespace = (r: ExperimentSourceRef) => r.sessionId ? r : { ...r, entryId: `${role}:${r.entryId}` };
      nextExperiments = { ...plan, target, explanations: plan.explanations.map((e) => ({ ...e, sources: e.sources.map(namespace) })), experiments: plan.experiments.map((e) => ({ ...e, sources: e.sources.map(namespace) })) };
    } catch { /* invalid proposal is not promoted to a scientific record */ }
  }
  return {
    ...(args.nextExperiments !== undefined ? { proposalOnly: true } : {}),
    ...(analysisPlan ? { analysisPlan } : {}),
    ...(robustness ? { robustness } : {}),
    ...(Array.isArray(args.results) ? { results: normalizeResultLinks(args.results).map((ref) => ({
      ...ref,
      // A child's local result is not a call in the parent's session log.
      toolCallId: ref.sessionId ? ref.toolCallId : `${role}:${ref.toolCallId}`,
      ...(!ref.sessionId ? { childLocal: true as const } : {}),
    })) } : {}),
    id,
    role,
    timestamp,
    type: args.type,
    title,
    body: typeof args.body === "string" ? args.body : undefined,
    // Same sandbox-relative normalization the lead's notebook tool applies —
    // subagents may echo absolute host paths.
    artifacts: Array.isArray(args.artifacts)
      ? args.artifacts.map((a) => stripSandboxRoot(String(a), sandboxRoot))
      : undefined,
    code,
    confidence:
      args.confidence === "low" || args.confidence === "medium" || args.confidence === "high"
        ? args.confidence
        : undefined,
    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    evidence: Array.isArray(args.evidence) ? normalizeEvidenceLinks(args.evidence).map((link) => ({
      ...link,
      // Only child-local targets are namespaced. Explicit project/session
      // references retain their original identities.
      entryId: link.sessionId ? link.entryId : `${role}:${link.entryId}`,
    })) : undefined,
    scope: typeof args.scope === "string" ? args.scope.slice(0, 2000) : undefined,
    revisitWhen: typeof args.revisitWhen === "string" ? args.revisitWhen.slice(0, 2000) : undefined,
    limitations: Array.isArray(args.limitations) ? args.limitations.filter((x): x is string => typeof x === "string").slice(0, 16).map((x) => x.slice(0, 2000)) : undefined,
    outcome: args.outcome === "signal" || args.outcome === "null" || args.outcome === "inconclusive" || args.outcome === "technical-failure" ? args.outcome : undefined,
    // Link targets are the child's own (raw) tool-call ids; namespace them the
    // same way entry ids are namespaced below so intra-subagent threads still
    // resolve after harvest. `runId` is never read from args — it is stamped
    // by the parent at append time (notebook-bridge).
    relatesTo:
      typeof args.relatesTo === "string" && args.relatesTo.trim()
        ? `${role}:${args.relatesTo.trim()}`
        : undefined,
    stance:
      args.stance === "supports" || args.stance === "refutes" || args.stance === "neutral"
        ? args.stance
        : undefined,
    supersedes:
      typeof args.supersedes === "string" && args.supersedes.trim()
        ? `${role}:${args.supersedes.trim()}`
        : undefined,
    ...(nextExperiments ? { nextExperiments, proposalOnly: true, stance: "neutral" as const,
      evidence: [{ entryId: nextExperiments.target.entryId, ...(nextExperiments.target.sessionId ? { sessionId: nextExperiments.target.sessionId } : {}), relation: "context" as const }],
      nextExperimentBinding: { kind: "proposal-context" as const, origin: "harvested" as const, capturedAt: Date.now(), sourceDigests: [] },
    } : {}),
  };
}

export function notebookEntriesFromSessionFile(
  sessionFile: string,
  agentName: string,
  sandboxRoot = "",
): NotebookEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const out: NotebookEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    const timestamp = Number.isNaN(ts) ? Date.now() : ts;
    for (const block of msg.content as unknown[]) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "toolCall" ||
        (block as { name?: unknown }).name !== "notebook"
      ) {
        continue;
      }
      const b = block as { id?: unknown; arguments?: unknown };
      const callId = typeof b.id === "string" ? b.id : "";
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      const entry = entryFromArgs(args, `${agentName}:${callId}`, agentName, timestamp, sandboxRoot);
      if (entry) out.push(entry);
    }
  }
  return out;
}
