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
  };
}

