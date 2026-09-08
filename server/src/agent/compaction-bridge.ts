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
 *      ids from the provenance log, the latest environment snapshot) — never
 *      from the model, so compaction cannot invent or drop state; then
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

export const PREAMBLE_VERSION = 1;
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
      break;
    }
  } catch {
    /* plan journal unreadable: the notebook lines below still carry the hypotheses */
  }

  const recent = entries.slice(-MAX_PREAMBLE_ENTRIES);
  if (recent.length > 0) {
    lines.push(`### Lab notebook (last ${recent.length} of ${entries.length} entries; ids are citable)`);
    for (const entry of recent) {
      const outcome = (entry as { outcome?: string }).outcome;
      lines.push(
        `- [${entry.type}] ${entry.id}: ${clip(entry.title, 160)}${outcome ? ` (outcome: ${outcome})` : ""}`,
      );
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
    /* provenance unreadable: omit */
  }

  if (lines.length === 1) lines.push("(no notebook entries, plans or results recorded yet)");
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

/** Make the science-aware compaction extension for one lead session. */
export function makeScientificCompactionExtension(
  projectId: string,
  getSessionId: () => string,
  options: {
    generate?: SummaryGenerator;
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
        let summary = `${preamble.text}\n\n## Conversation summary\n${main.text}`;
        let usage = main.usage;
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
          usage = addUsage(usage, prefix.usage);
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
