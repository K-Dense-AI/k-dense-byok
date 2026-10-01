/**
 * Usage a tool reported on its own result (`ToolResultMessage.usage`), split
 * from the turn's model usage so it is ledgered under the right billing.
 *
 * Pi adds a tool result's usage to `getSessionStats()`, so it lands in a
 * run's before/after delta, which the ledger bills as the turn's model. Two
 * kinds of tool usage do not belong there:
 *
 *   - Model calls a tool makes itself. Pi 1.0 codemode scripts call
 *     `models.classify()` and `models.generateImages()` with the session's
 *     credentials, and Kady's `generate_image` tool does the same. Those
 *     models need not share the turn's provider or credential: a turn on a
 *     ChatGPT subscription can generate images through OpenRouter. Billed as
 *     the turn, real pay-as-you-go spend would be recorded as $0 subscription
 *     usage and slip past the project cap, so each is ledgered under its own
 *     provider (`ToolUsageSplit.models`).
 *   - Child-agent usage. pi-subagents attaches the children's aggregated usage
 *     to the `subagent` result, but every child request is already ledgered
 *     (subagent-meter.ts, or the completion bridge for unmetered runs), so it
 *     is excluded from the turn's row instead (`delegated`).
 *
 * Any other tool usage stays in the turn's delta, billed as before.
 */
import { addTurnUsage, emptySnapshot, type CostSnapshot } from "./ledger.ts";

/** Tools whose result usage is child-agent work ledgered elsewhere. */
const DELEGATION_TOOLS = new Set(["subagent", "bg_wait", "subagent_wait"]);

/** Usage shape shared by pi-ai `Usage` and the ledger's tally helper. */
type UsageLike = Parameters<typeof addTurnUsage>[1];

interface ToolResultLike {
  toolName?: string;
  usage?: UsageLike;
  details?: unknown;
}

/** One model a tool called itself, as a canonical `provider/model` ref. */
interface ModelCall {
  ref: string;
  cost: number;
}

export interface ToolUsageSplit {
  /** Child-agent usage already ledgered by the subagent meter/bridge. */
  delegated: CostSnapshot;
  /** Usage of models a tool ran itself, keyed by `provider/model` ref. */
  models: Map<string, CostSnapshot>;
}

export function emptyToolUsageSplit(): ToolUsageSplit {
  return { delegated: emptySnapshot(), models: new Map() };
}

function hasUsage(usage: UsageLike | undefined): usage is UsageLike {
  if (!usage) return false;
  const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return tokens > 0 || (usage.cost?.total ?? 0) > 0;
}

/**
 * Models named by a tool's details: codemode's nested call rows
 * (`{ name: "models.generateImages", args: "openrouter/google/…", cost }`) or a
 * tool that reports `{ model: "provider/id" }` itself (`generate_image`).
 */
function modelCalls(details: unknown): ModelCall[] {
  if (!details || typeof details !== "object") return [];
  const record = details as { calls?: unknown; model?: unknown };
  const calls: ModelCall[] = [];
  if (Array.isArray(record.calls)) {
    for (const call of record.calls as Array<{ name?: unknown; args?: unknown; cost?: unknown }>) {
      if (typeof call?.name !== "string" || !call.name.startsWith("models.")) continue;
      if (typeof call.args !== "string" || !call.args.includes("/")) continue;
      calls.push({ ref: call.args, cost: typeof call.cost === "number" && Number.isFinite(call.cost) ? Math.max(0, call.cost) : 0 });
    }
  }
  if (calls.length === 0 && typeof record.model === "string" && record.model.includes("/")) {
    calls.push({ ref: record.model, cost: 0 });
  }
  return calls;
}

/** Scale a usage tally by a share in [0, 1]; token counts stay whole. */
function scaled(usage: UsageLike, share: number): UsageLike {
  if (share === 1) return usage;
  return {
    input: Math.round((usage.input ?? 0) * share),
    output: Math.round((usage.output ?? 0) * share),
    cacheRead: Math.round((usage.cacheRead ?? 0) * share),
    cacheWrite: Math.round((usage.cacheWrite ?? 0) * share),
    cost: { total: (usage.cost?.total ?? 0) * share },
  };
}

/** Fold one turn's tool results into the split. */
export function addToolResultUsage(split: ToolUsageSplit, toolResults: readonly unknown[] | undefined): void {
  for (const raw of toolResults ?? []) {
    const result = raw as ToolResultLike;
    if (!hasUsage(result.usage)) continue;
    if (result.toolName && DELEGATION_TOOLS.has(result.toolName)) {
      addTurnUsage(split.delegated, result.usage);
      continue;
    }
    const calls = modelCalls(result.details);
    if (calls.length === 0) continue;
    // Several models in one script: apportion by each call's reported cost
    // (evenly when none is priced). Tokens are only reported in total.
    const byRef = new Map<string, number>();
    for (const call of calls) byRef.set(call.ref, (byRef.get(call.ref) ?? 0) + call.cost);
    const totalCost = [...byRef.values()].reduce((sum, cost) => sum + cost, 0);
    for (const [ref, cost] of byRef) {
      const share = totalCost > 0 ? cost / totalCost : 1 / byRef.size;
      const tally = split.models.get(ref) ?? emptySnapshot();
      addTurnUsage(tally, scaled(result.usage, share));
      split.models.set(ref, tally);
    }
  }
}

/** `a - b`, field-wise and clamped at 0. */
export function snapshotMinus(a: CostSnapshot, b: CostSnapshot): CostSnapshot {
  return {
    costUsd: Math.max(0, a.costUsd - b.costUsd),
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    total: Math.max(0, a.total - b.total),
  };
}

/** Everything the split takes out of the turn's own row. */
export function splitTotal(split: ToolUsageSplit): CostSnapshot {
  const total = { ...split.delegated };
  for (const tally of split.models.values()) {
    total.costUsd += tally.costUsd;
    total.input += tally.input;
    total.output += tally.output;
    total.cacheRead += tally.cacheRead;
    total.total += tally.total;
  }
  return total;
}
