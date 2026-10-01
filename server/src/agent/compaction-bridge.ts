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
 *      instructions that map Pi's checkpoint format onto research work and
 *      add a Scientific Record section. The model sees the preamble too, so
 *      it can cite record ids instead of contradicting them; then
 *   3. Pi's `<read-files>`/`<modified-files>` lists, carried across
 *      compactions by parsing the previous summary (Pi ignores the `details`
 *      of hook-made compactions, so it cannot carry them for us).
 *
 * Only the narrative of an earlier summary is reused: its records are
 * regenerated from the stores, and passing them on would hand the model stale
 * job/specialist states to "preserve" and nest one preamble inside the next.
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

export const PREAMBLE_VERSION = 3;
const MAX_PREAMBLE_ENTRIES = 20;
const MAX_EARLIER_HYPOTHESES = 15;
const MAX_RESULT_IDS = 30;
const MAX_FIELD_CHARS = 400;

const RECORDS_HEADING = "## Kady scientific state";
const NARRATIVE_HEADING = "## Conversation summary";
const TURN_PREFIX_HEADING = "## Current turn so far";

/**
 * Pi's serializer keeps only the first 2,000 characters of each tool result
 * (`TOOL_RESULT_MAX_CHARS`). Analyses print their numbers last and a traceback
 * ends with the exception, so longer results are clipped to both ends first.
 */
const PI_TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_RESULT_HEAD_CHARS = 1_100;
const TOOL_RESULT_TAIL_CHARS = 800;

/**
 * Appended by Pi after its checkpoint format as "Additional focus: …", so it
 * says how to fill those sections for research rather than restating them.
 */
export const SCIENCE_COMPACTION_INSTRUCTIONS = [
  "This is a scientific analysis session in Kady. Fill the format above for research work:",
  "- Goal: the research question(s) and the deliverable the user asked for.",
  "- Constraints & Preferences: the user's instructions, data restrictions, budgets, and the exact scope of any approval (authorization is not execution).",
  "- Progress: mark each item planned, attempted, completed or independently verified; submitted or running work is not completed.",
  "- Key Decisions: each analysis choice, its reason and the alternatives rejected.",
  "- Next Steps: the next planned step and the open questions.",
  "",
  'After Critical Context, add this section, writing "(none)" under any empty heading:',
  "",
  "## Scientific Record",
  "### Hypotheses",
  "- Each hypothesis, its status (supported, refuted, mixed, inconclusive or open) and the ids of the notebook entries, results or files behind it.",
  "### Results",
  "- Numeric results with units, sample sizes and uncertainty, and the input and output paths that produced them.",
  "### Methods & Parameters",
  "- Exact parameter values, thresholds, filters, random seeds, software versions and commands.",
  "### Failures & Caveats",
  "- Failed runs with their error text, data-quality warnings and limitations.",
  "### Corrections",
  "- Superseded, corrected or retracted findings and the ids that replace them.",
  "### Outstanding Work",
  "- Subagent run/child ids and Modal job ids, their last observed state and where to check it.",
  "",
  "Rules:",
  '- Copy numbers, units, paths, ids, parameters and error messages exactly. Write "not recorded" rather than estimating a missing value. Long tool results above are clipped with an omission marker; never reconstruct the omitted part.',
  "- Keep null or inconclusive evidence and technical failures distinct from refutation. Do not promote a provisional claim to verified, an authored interpretation to an observed output, or an unchanged file hash to scientific validity.",
  "- Never restate a superseded or retracted result as current, including one carried in the previous summary.",
  "- A missing completion notice is not permission to relaunch work; keep the ids so the status can be checked.",
  "- Do not summarize away caveats, failed runs or data-quality warnings.",
].join("\n");

/** Leads the instructions for the first part of a turn that is still running. */
export const TURN_PREFIX_FOCUS = [
  "These messages are only the start of the turn still in progress; the rest of the turn is kept verbatim after this summary.",
  "Summarize only what they show (the request that opened the turn, the work done, and the results and decisions so far) and do not guess at later messages.",
].join(" ");

/** Shows the model the records Kady stores above its summary. */
function recordsInstructions(records: string): string {
  return [
    "Kady stores the record block below verbatim above your summary and regenerates it from its stores at every compaction.",
    "It is newer than the conversation, so where they disagree, follow the block. It lists only recent notebook entries, so still give each hypothesis and result that matters a one-line statement with its id, but do not copy the block wholesale.",
    `<kady-records>\n${records}\n</kady-records>`,
  ].join(" ");
}

function joinInstructions(parts: Array<string | undefined>, custom: string | undefined): string {
  const text = custom?.trim();
  return [...parts, text ? `Instructions from the user for this compaction (they take precedence):\n${text}` : undefined]
    .filter(Boolean)
    .join("\n\n");
}

const FILE_TAGS = ["read-files", "modified-files"] as const;

function taggedFiles(summary: string | undefined, tag: (typeof FILE_TAGS)[number]): string[] {
  const match = summary?.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return match ? match[1].split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function stripFileTags(text: string): string {
  return text.replace(/\n*<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>/g, "");
}

/**
 * The part of an earlier summary worth carrying forward. A Kady summary's
 * records are regenerated, so only what follows them is kept; a summary from
 * Pi's default compaction is all narrative. File lists are re-appended fresh.
 */
export function previousNarrative(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  let text = summary;
  if (text.startsWith(RECORDS_HEADING)) {
    // Record fields are clipped to one line, so the first narrative heading
    // at the start of a line is ours.
    const starts = [`\n${NARRATIVE_HEADING}\n`, `\n${TURN_PREFIX_HEADING}\n`]
      .map((heading) => text.indexOf(heading))
      .filter((index) => index >= 0);
    if (starts.length === 0) return undefined;
    text = text.slice(Math.min(...starts) + 1);
    if (text.startsWith(`${NARRATIVE_HEADING}\n`)) text = text.slice(NARRATIVE_HEADING.length + 1);
  }
  text = stripFileTags(text).trim();
  return text || undefined;
}

type FileOps = SessionBeforeCompactEvent["preparation"]["fileOps"];

/** Pi's read/modified split, unioned with the lists the previous summary carried. */
export function compactionFileLists(
  fileOps: Partial<FileOps> | undefined,
  previousSummary: string | undefined,
): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([
    ...(fileOps?.edited ?? []),
    ...(fileOps?.written ?? []),
    ...taggedFiles(previousSummary, "modified-files"),
  ]);
  const read = new Set([...(fileOps?.read ?? []), ...taggedFiles(previousSummary, "read-files")]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** Same tags as Pi's `formatFileOperations`, so either kind of summary can follow the other. */
function formatFileLists(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

type SummaryMessage = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

/** Copies (never mutates) tool results longer than Pi keeps, as head + tail. */
export function clipToolResultsForSummary(messages: SummaryMessage[]): SummaryMessage[] {
  return messages.map((message) => {
    const { role, content } = message as { role?: string; content?: unknown };
    if (role !== "toolResult" || !Array.isArray(content)) return message;
    const text = content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text.length <= PI_TOOL_RESULT_MAX_CHARS) return message;
    const omitted = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
    const clipped = `${text.slice(0, TOOL_RESULT_HEAD_CHARS)}\n[… ${omitted} characters omitted …]\n${text.slice(-TOOL_RESULT_TAIL_CHARS)}`;
    return { ...message, content: [{ type: "text", text: clipped }] } as SummaryMessage;
  });
}

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
  const lines: string[] = [`${RECORDS_HEADING} (derived from the lab notebook, plan journal and provenance log)`];
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
  // A hypothesis older than the recent window is still the frame later
  // results are read against; keep a line for each one not superseded.
  const recentIds = new Set(recent.map((entry) => entry.id));
  const earlier = entries.filter(
    (entry) => entry.type === "hypothesis" && !recentIds.has(entry.id) && !threads.get(entry.id)?.supersededBy,
  );
  if (earlier.length > 0) {
    const shown = earlier.slice(-MAX_EARLIER_HYPOTHESES);
    lines.push(`### Earlier hypotheses (${earlier.length} before the recent window, not superseded)`);
    for (const entry of shown) {
      const status = threads.get(entry.id)?.status;
      lines.push(`- ${entry.id}: ${clip(entry.title, 160)}${status ? ` (evidence interpretation: ${status}; authored links)` : ""}`);
    }
    if (earlier.length > shown.length) lines.push(`- ${earlier.length - shown.length} older hypotheses omitted; consult the notebook.`);
  }
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
        const records = `${preamble.text}\n\n${childWorkSummary(childStatus)}`;
        const previous = previousNarrative(prep.previousSummary);
        let summary = records;
        let usage: Usage | undefined;
        // Mirror Pi: when the cut point falls inside the only turn there is
        // nothing before it to summarize — asking the model to summarize an
        // empty conversation yields a "no messages provided" narrative.
        if (prep.messagesToSummarize.length > 0) {
          const main = await generate(
            clipToolResultsForSummary(prep.messagesToSummarize),
            model,
            prep.settings.reserveTokens,
            auth.apiKey,
            headers,
            event.signal,
            joinInstructions([SCIENCE_COMPACTION_INSTRUCTIONS, recordsInstructions(records)], event.customInstructions),
            previous,
            ctx.thinkingLevel,
            undefined,
            auth.env,
          );
          summary += `\n\n${NARRATIVE_HEADING}\n${main.text}`;
          usage = main.usage;
        } else if (previous) {
          summary += `\n\n${NARRATIVE_HEADING}\n${previous}`;
        }
        if (prep.isSplitTurn && prep.turnPrefixMessages.length > 0) {
          // Mirror Pi: the cut point fell inside a turn, so the turn's earlier
          // part is summarized separately and appended. In an agentic analysis
          // one turn can hold most of the work, so it keeps the science focus.
          const prefix = await generate(
            clipToolResultsForSummary(prep.turnPrefixMessages),
            model,
            prep.settings.reserveTokens,
            auth.apiKey,
            headers,
            event.signal,
            joinInstructions([TURN_PREFIX_FOCUS, SCIENCE_COMPACTION_INSTRUCTIONS], event.customInstructions),
            undefined,
            ctx.thinkingLevel,
            undefined,
            auth.env,
          );
          summary += `\n\n${TURN_PREFIX_HEADING}\n${prefix.text}`;
          usage = usage ? addUsage(usage, prefix.usage) : prefix.usage;
        }
        const { readFiles, modifiedFiles } = compactionFileLists(prep.fileOps, prep.previousSummary);
        summary += formatFileLists(readFiles, modifiedFiles);
        return {
          compaction: {
            summary,
            firstKeptEntryId: prep.firstKeptEntryId,
            tokensBefore: prep.tokensBefore,
            usage,
            details: {
              readFiles,
              modifiedFiles,
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
