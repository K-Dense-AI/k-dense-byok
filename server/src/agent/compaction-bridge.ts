/**
 * Compaction you control.
 *
 * Pi compacts a session's context with a generic coding summary once it nears
 * the model's window. For a long analysis that loses exactly what a scientist
 * needs to keep: the frozen plan, the live hypotheses, which results exist and
 * under which environment. This extension hooks `session_before_compact` and
 * returns its own `CompactionResult`:
 *
 *   1. a deterministic **scientific state preamble** derived from Kady's own
 *      stores (notebook entries, the frozen analysis plan, scientific_result
 *      ids from the provenance log, the latest environment snapshot). This
 *      bounded block copies records without model rewriting; notebook claims
 *      remain authored and omitted/unavailable evidence is explicit; then
 *   2. the narrative summary Pi itself would have written, generated with
 *      Pi's exported `generateSummaryWithUsage` under science-focused
 *      instructions (keep parameters, paths, numbers with units, decisions).
 *
 * Usage from the summary call rides `CompactionResult.usage`, which Pi persists
 * on the compaction entry and folds into `getSessionStats()`, so the cost is
 * ledgered like any other turn. On any failure the handler returns `undefined`
 * and Pi's default compaction runs; it never cancels.
 */
import {
  generateSummaryWithUsage,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { latestFrozenPlan, PLAN_TEXT_FIELDS } from "../../../web/src/lib/notebook-plans.ts";
import { readNotebookEntries, type NotebookEntry } from "./notebook-store.ts";
import { withNotebookPlanHistory } from "./notebook-research.ts";
import { readEnvironment } from "../provenance/environment.ts";
import { readSteps } from "../provenance/store.ts";
import { deriveEvidenceThreads } from "../../../web/src/lib/notebook-evidence-core.ts";
import { normalizeNotebookExecution } from "../../../web/src/lib/notebook-execution.ts";
import { ModalJobStore } from "../modal/store.ts";
import { isTerminalModalState } from "../modal/types.ts";

export const PREAMBLE_VERSION = 2;
const MAX_PREAMBLE_ENTRIES = 20;
const MAX_RESULT_IDS = 30;
const MAX_FIELD_CHARS = 400;

export const SCIENCE_COMPACTION_INSTRUCTIONS = [
  "This is a scientific analysis session. Preserve, verbatim where possible:",
  "- every hypothesis and whether it is supported, refuted or open;",
  "- exact parameter values, thresholds, filters and random seeds used;",
  "- file paths of inputs read and outputs written (scripts, tables, figures);",
  "- numeric results with units, sample sizes and uncertainty;",
  "- decisions made and the reason for each, including rejected alternatives;",
  "- open questions and the next planned step.",
  "- evidence status: planned/attempted/completed versus independently verified, authored interpretations versus observed outputs, and the source ids supporting each claim;",
  "- superseded/corrected/retracted findings and replacement ids; never resurrect an obsolete result from an earlier summary;",
  "- pending subagent run/child ids and Modal job ids, last observed states and where to check them; submitted or running is not completed, and a missing completion notice is not permission to launch a duplicate;",
  "- frozen-plan revisions, recorded deviations, unresolved blockers and the exact scope of existing approvals (authorization is not execution).",
  "Keep null/inconclusive evidence and technical failure distinct from refutation. Do not promote a provisional claim to verified, or unchanged artifact identity to scientific validity. Preserve uncertainty and missing evidence explicitly.",
  "Do not summarize away caveats, failed runs or data-quality warnings.",
].join("\n");

export interface CompactionPreamble {
  text: string;
  planRevision?: number;
  environmentId?: string;
  resultIds: string[];
  entryCount: number;
}

function clip(value: string | undefined, max = MAX_FIELD_CHARS): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Deterministic state block from Kady's stores; no model involved. */
export function buildCompactionPreamble(projectId: string, sessionId: string): CompactionPreamble {
  const lines: string[] = ["## Kady scientific state (derived from the lab notebook, plan journal and provenance log)"];
  let planRevision: number | undefined;
  let environmentId: string | undefined;
  const resultIds: string[] = [];

  let entries: NotebookEntry[] = [];
  try {
    entries = readNotebookEntries(sessionId, projectId);
  } catch {
    entries = [];
    lines.push("Notebook records unavailable; do not infer an empty history.");
  }

  // Frozen analysis plan: the latest hypothesis entry with a frozen revision.
  try {
    const hypotheses = withNotebookPlanHistory(
      entries.filter((entry) => entry.type === "hypothesis"),
      projectId,
      sessionId,
    );
    for (const entry of [...hypotheses].reverse()) {
      const frozen = entry.planHistory ? latestFrozenPlan(entry.planHistory) : undefined;
      if (!frozen) continue;
      planRevision = frozen.revision;
      lines.push(`### Frozen analysis plan (revision ${frozen.revision}, entry ${entry.id})`);
      for (const [field, label] of Object.entries(PLAN_TEXT_FIELDS)) {
        const value = clip(frozen.plan[field as keyof typeof PLAN_TEXT_FIELDS]);
        if (value) lines.push(`- ${label}: ${value}`);
      }
      if (frozen.plan.datasets?.length) lines.push(`- Datasets: ${frozen.plan.datasets.join(", ")}`);
      lines.push(`- Intent: ${frozen.plan.intent}; prior exposure: ${frozen.plan.priorExposure}`);
      lines.push("- This plan is intended work, not proof of execution or external preregistration.");
      const deviations = entry.planHistory!.events.filter((event) => event.kind === "deviation");
      for (const deviation of deviations.slice(-10)) {
        if (deviation.kind !== "deviation") continue;
        lines.push(`- Deviation ${deviation.id} for plan ${deviation.planId}: ${deviation.field} → ${clip(deviation.actual)}; reason: ${clip(deviation.reason)}; timing: ${deviation.timing}${deviation.corrects ? `; corrects ${deviation.corrects}` : ""}`);
      }
      if (deviations.length > 10) lines.push(`- ${deviations.length - 10} earlier deviations omitted; consult the plan journal before reuse.`);
      break;
    }
  } catch {
    lines.push("Plan journal unavailable; do not infer that there is no frozen plan or deviation.");
  }

  const recent = entries.slice(-MAX_PREAMBLE_ENTRIES);
  const threads = deriveEvidenceThreads(entries);
  if (recent.length > 0) {
    lines.push(`### Lab notebook (last ${recent.length} of ${entries.length} entries; ids are citable)`);
    for (const entry of recent) {
      const outcome = (entry as { outcome?: string }).outcome;
      const thread = threads.get(entry.id);
      const execution = normalizeNotebookExecution(entry.execution);
      lines.push(
        `- [${entry.type}] ${entry.id}: ${clip(entry.title, 160)}${outcome ? ` (outcome: ${outcome})` : ""}`,
      );
      lines.push(`  Execution: ${execution?.status ?? "unverified"} (authored report, not independent verification).${execution?.evidence ? ` Evidence: ${clip(execution.evidence)}` : ""}`);
      if (entry.proposalOnly || entry.nextExperiments || entry.nextExperimentDecision) lines.push("  Planning context only; not an observation or execution approval.");
      if (thread?.supersededBy) lines.push(`  SUPERSEDED by ${thread.supersededBy}; do not reuse as a current finding.`);
      if (entry.supersedes) lines.push(`  Amends ${entry.supersedes}; preserve this correction.`);
      if (thread?.status) lines.push(`  Evidence interpretation: ${thread.status} (authored links, not a verified verdict).`);
      if (entry.limitations?.length) lines.push(`  Limitations: ${clip(entry.limitations.join("; "))}`);
      if (entry.artifacts?.length) lines.push(`  Referenced artifacts: ${clip(entry.artifacts.join(", "))}; identity/currentness not rechecked during compaction.`);
    }
  }

  try {
    const steps = readSteps(sessionId, projectId);
    for (const step of steps) {
      if (step.toolName === "scientific_result" && !step.isError) resultIds.push(step.id);
      if (step.environmentId && !step.environmentAt) environmentId = step.environmentId;
    }
    if (resultIds.length > 0) {
      const shown = resultIds.slice(-MAX_RESULT_IDS);
      lines.push(
        `### Structured results (${resultIds.length} scientific_result cards; reference by id)`,
        `- ${shown.join(", ")}`,
      );
    }
    if (environmentId) {
      const env = readEnvironment(environmentId, projectId);
      const parts: string[] = [];
      if (env?.python) {
        parts.push(
          `Python ${env.python.version ?? "?"} (${env.python.source}, ${env.python.packages.length} packages)`,
        );
      }
      if (env?.r) parts.push(`R ${env.r.version} (${env.r.packages.length} packages)`);
      if (env?.git) parts.push(`git ${env.git.head.slice(0, 12)}`);
      lines.push(`### Environment snapshot ${environmentId}${parts.length ? `: ${parts.join("; ")}` : ""}`);
    }
  } catch {
    lines.push("Provenance unavailable; result and environment evidence may be incomplete.");
  }

  if (lines.length === 1) lines.push("(no notebook entries, plans or results recorded yet)");
  try {
    const jobs = new ModalJobStore().list(projectId).filter((job) => job.owner?.sessionId === sessionId && !isTerminalModalState(job.state));
    lines.push(`### Pending Modal work (${jobs.length} readable session records; recheck status before continuing)`);
    for (const job of jobs.slice(0, 30)) {
      lines.push(`- job ${job.id}: ${job.state}; last recorded update ${job.updatedAt}; use modal_status/modal_wait, do not resubmit merely because compaction occurred.`);
    }
    if (jobs.length > 30) lines.push(`- ${jobs.length - 30} additional jobs omitted; inspect the session's compute records.`);
    lines.push("Unreadable/missing records are not proof that no remote work exists.");
  } catch {
    lines.push("Pending Modal work: unavailable; recover job ids from the transcript and check status before launching replacements.");
  }
  return {
    text: lines.join("\n"),
    ...(planRevision !== undefined ? { planRevision } : {}),
    ...(environmentId ? { environmentId } : {}),
    resultIds,
    entryCount: entries.length,
  };
}

export type SummaryGenerator = (
  ...args: Parameters<typeof generateSummaryWithUsage>
) => ReturnType<typeof generateSummaryWithUsage>;

/** Retain public control ids verbatim; display ordering is not a control target. */
export function childWorkSummary(snapshot: unknown): string {
  const state = (snapshot as { asyncSnapshot?: { runs?: unknown; omitted?: { runs?: number; children?: number; byteLimitExceeded?: boolean } } } | undefined)?.asyncSnapshot;
  const runs = state?.runs;
  if (!Array.isArray(runs)) return "### Specialist work\nLive status unavailable. Preserve transcript run/child ids and query subagent status before resuming or relaunching.";
  const lines = ["### Specialist work (snapshot at compaction; recheck live status before acting)"];
  let count = 0;
  let truncated = Boolean(state?.omitted?.runs || state?.omitted?.children || state?.omitted?.byteLimitExceeded);
  const visit = (rows: unknown[], depth: number) => {
    for (const raw of rows) {
      if (++count > 100 || depth > 5) { truncated = true; return; }
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const state = typeof row.state === "string" ? row.state : "unknown";
      if (!["complete", "completed", "succeeded", "failed", "cancelled", "stopped", "aborted", "done", "error", "rejected"].includes(state)) {
        const control = row.control as Record<string, unknown> | undefined;
        lines.push(`- ${clip(typeof row.id === "string" ? row.id : "unknown id")}: ${clip(state)}${control && typeof control.runId === "string" && Number.isInteger(control.index) && typeof control.childId === "string" ? `; control ${JSON.stringify({ runId: control.runId, index: control.index, childId: control.childId })}` : ""}`);
      }
      if (Array.isArray(row.children)) visit(row.children, depth + 1);
    }
  };
  visit(runs, 0);
  if (lines.length === 1 && !truncated) lines.push("No pending children in this snapshot; terminal scientific results still require inspection.");
  if (truncated) lines.push("Snapshot truncated; query subagent status for remaining work before launching replacements.");
  return lines.join("\n");
}

/** Make the science-aware compaction extension for one lead session. */
export function makeScientificCompactionExtension(
  projectId: string,
  getSessionId: () => string,
  options: {
    generate?: SummaryGenerator;
    readChildStatus?: () => Promise<unknown>;
    log?: { warn(obj: unknown, msg?: string): void };
  } = {},
): ExtensionFactory {
  const generate = options.generate ?? generateSummaryWithUsage;
  const log = options.log ?? console;
  return (pi) => {
    pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
      const sessionId = getSessionId();
      const model = ctx.model;
      if (!sessionId || !model) return undefined;
      try {
        const prep = event.preparation;
        const preamble = buildCompactionPreamble(projectId, sessionId);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          log.warn({ error: auth.error }, "no credentials for the compaction model; using Pi's default");
          return undefined;
        }
        const headers = resolveHeaders(auth.headers);
        const instructions = [SCIENCE_COMPACTION_INSTRUCTIONS, event.customInstructions?.trim()]
          .filter(Boolean)
          .join("\n\n");
        // Mirror Pi: when the cut point falls inside the only turn there is
        // nothing before it to summarize — asking the model to summarize an
        // empty conversation yields a "no messages provided" narrative.
        let childStatus: unknown;
        if (options.readChildStatus) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            childStatus = await Promise.race([
              options.readChildStatus(),
              new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1500); }),
            ]);
          } catch { /* unavailable state remains explicit in the summary */ }
          finally { if (timer) clearTimeout(timer); }
        }
        let summary = `${preamble.text}\n\n${childWorkSummary(childStatus)}`;
        let usage: Usage | undefined;
        if (prep.messagesToSummarize.length > 0) {
          const main = await generate(
            prep.messagesToSummarize,
            model,
            prep.settings.reserveTokens,
            auth.apiKey,
            headers,
            event.signal,
            instructions,
            prep.previousSummary,
            ctx.thinkingLevel,
            undefined,
            auth.env,
          );
          summary += `\n\n## Conversation summary\n${main.text}`;
          usage = main.usage;
        } else if (prep.previousSummary) {
          summary += `\n\n## Conversation summary\n${prep.previousSummary}`;
        }
        if (prep.isSplitTurn && prep.turnPrefixMessages.length > 0) {
          // Mirror Pi: the cut point fell inside a turn, so the turn's earlier
          // part is summarized separately and appended.
          const prefix = await generate(
            prep.turnPrefixMessages,
            model,
            prep.settings.reserveTokens,
            auth.apiKey,
            headers,
            event.signal,
            instructions,
            undefined,
            ctx.thinkingLevel,
            undefined,
            auth.env,
          );
          summary += `\n\n## Current turn so far\n${prefix.text}`;
          usage = usage ? addUsage(usage, prefix.usage) : prefix.usage;
        }
        return {
          compaction: {
            summary,
            firstKeptEntryId: prep.firstKeptEntryId,
            tokensBefore: prep.tokensBefore,
            usage,
            details: {
              kady: {
                preambleVersion: PREAMBLE_VERSION,
                ...(preamble.planRevision !== undefined ? { planRevision: preamble.planRevision } : {}),
                ...(preamble.environmentId ? { environmentId: preamble.environmentId } : {}),
                resultIds: preamble.resultIds,
                reason: event.reason,
              },
            },
          },
        };
      } catch (err) {
        if (event.signal.aborted) return undefined;
        log.warn({ err }, "scientific compaction failed; falling back to Pi's default summary");
        return undefined;
      }
    });
    pi.on("session_compact_failed", (event) => {
      if (!event.aborted) {
        log.warn({ reason: event.reason, error: event.errorMessage }, "context compaction failed");
      }
    });
  };
}

type Usage = Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"];

/** Pi provider headers may be static or lazily computed; the summary API wants a record. */
function resolveHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof headers === "function") {
    try {
      const value = (headers as () => unknown)();
      return value && typeof value === "object" ? (value as Record<string, string>) : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof headers === "object" ? (headers as Record<string, string>) : undefined;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    ...a,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
