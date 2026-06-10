/**
 * Integration glue for the `pi-subagents` package (npm:pi-subagents).
 *
 * The package is a Pi extension that registers a `subagent` tool and runs each
 * delegation as a separate `pi` CLI process (the binary ships with our
 * @earendil-works/pi-coding-agent dependency, so `server/node_modules/.bin`
 * must be on PATH — ensured in session-registry).
 *
 * Three pieces live here:
 *  1. `subagentsExtensionPath()` — locates the package's extension entry so
 *     DefaultResourceLoader can load it per session.
 *  2. `makeSubagentLedgerExtension()` — our own extension that (a) blocks
 *     `subagent` calls once the project's spend cap is hit, and (b) ledgers
 *     each child run's usage (child processes have their own sessions, so
 *     their spend would otherwise be invisible to the project budget).
 * Agent definition files themselves (seeding, parsing, CRUD) live in
 * agent-files.ts; the seeding call happens in session-registry before each
 * session build.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isBudgetExceeded, recordSubagentRun } from "../cost/ledger.ts";

const require_ = createRequire(import.meta.url);

/** Entry file of the pi-subagents extension (per its package.json `pi.extensions`). */
export function subagentsExtensionPath(): string {
  const pkgJson = require_.resolve("pi-subagents/package.json");
  return path.join(path.dirname(pkgJson), "src", "extension", "index.ts");
}

/** Shape of the pi-subagents tool result details we consume (subset). */
interface SubagentRunDetails {
  results?: Array<{
    agent?: string;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
    };
  }>;
}

// SUBAGENT_ASYNC_COMPLETE_EVENT in pi-subagents (src/shared/types.ts). Async
// runs return a tool result with `results: []` immediately; the real results
// arrive on this pi.events channel when the detached child finishes.
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** Subset of the async completion payload (the runner's result-file JSON). */
interface AsyncCompletePayload {
  id?: string | null;
  results?: Array<{ agent?: string; model?: string; sessionFile?: string }>;
}

/**
 * Sum assistant-message usage from a child Pi session JSONL. The async result
 * payload carries no usage numbers, but it names each child's session file —
 * and Pi records per-message usage (cost included) there.
 */
export function usageFromSessionFile(
  file: string,
): { cost: number; tokens: { input: number; output: number; cacheRead: number; total: number } } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { message?: { role?: string; usage?: Record<string, unknown> } };
      const m = entry.message ?? (entry as { role?: string; usage?: Record<string, unknown> });
      if (m?.role !== "assistant" || !m.usage) continue;
      const u = m.usage as {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
      cost += u.cost?.total ?? 0;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
    } catch {
      /* skip malformed lines */
    }
  }
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0 && cost === 0) return null;
  return { cost, tokens: { input, output, cacheRead, total } };
}

// Async completions already ledgered, keyed by run id + child session file.
// Module-level because every live session registers its own listener and
// pi-subagents may deliver the same completion to more than one of them.
const ledgeredAsyncRuns = new Set<string>();

/**
 * Budget gate + cost ledger for subagent runs, as a Pi extension.
 *
 * `getSessionId` is lazy because the extension is constructed before the
 * session exists (same holder pattern as the old spawn tool).
 */
export function makeSubagentLedgerExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "subagent") return;
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        return {
          block: true,
          reason:
            `Delegation blocked: the project has reached its spend limit ` +
            `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
            `Finish the task without subagents or ask the user to raise the limit.`,
        };
      }
    });

    pi.on("tool_result", async (event) => {
      if (event.toolName !== "subagent") return;
      const details = event.details as SubagentRunDetails | undefined;
      for (const result of details?.results ?? []) {
        const usage = result.usage;
        if (!usage) continue;
        const input = usage.input ?? 0;
        const output = usage.output ?? 0;
        const cacheRead = usage.cacheRead ?? 0;
        const cacheWrite = usage.cacheWrite ?? 0;
        recordSubagentRun(projectId, getSessionId(), result.model ?? "unknown", {
          cost: usage.cost ?? 0,
          tokens: {
            input,
            output,
            cacheRead,
            total: input + output + cacheRead + cacheWrite,
          },
        });
      }
    });

    // Async runs bypass the tool_result path (it carries `results: []`), so
    // ledger them from the completion event, reading usage out of each child's
    // session file.
    pi.events.on(ASYNC_COMPLETE_EVENT, (data: unknown) => {
      const payload = data as AsyncCompletePayload;
      for (const result of payload.results ?? []) {
        if (!result.sessionFile) continue;
        const key = `${payload.id ?? ""}:${result.sessionFile}`;
        if (ledgeredAsyncRuns.has(key)) continue;
        ledgeredAsyncRuns.add(key);
        if (ledgeredAsyncRuns.size > 1000) ledgeredAsyncRuns.clear();
        const usage = usageFromSessionFile(result.sessionFile);
        if (usage) {
          recordSubagentRun(projectId, getSessionId(), result.model ?? "unknown", usage);
        }
      }
    });
  };
}

