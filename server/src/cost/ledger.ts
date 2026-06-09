/**
 * Cost ledger + budget caps — TS port of the cost bits of kady_agent/runtime.py.
 *
 * Pi reports cumulative `{tokens, cost}` per session via getSessionStats(), and
 * computes USD from each model's pricing. We snapshot stats before/after a run
 * and append the delta as one JSONL row, so the ledger keeps per-run granularity
 * without the OpenRouter async backfill the old stack needed.
 *
 * Layout (unchanged): projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl
 * Role is "agent" | "subagent" (the orchestrator/expert split is gone).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { activePaths, getProject, resolvePaths } from "../projects.ts";

export interface CostSnapshot {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

export interface CostEntry {
  entryId: string;
  ts: number;
  sessionId: string;
  role: "agent" | "subagent";
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
}

function costsPath(sessionId: string, projectId?: string): string {
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.runsDir, sessionId, "costs.jsonl");
}

/** Append a ledger row for the delta between two cumulative snapshots. */
export function recordRun(args: {
  sessionId: string;
  model: string;
  before: CostSnapshot;
  after: CostSnapshot;
  role?: "agent" | "subagent";
  projectId?: string;
}): CostEntry | null {
  const d = {
    costUsd: Math.max(0, args.after.costUsd - args.before.costUsd),
    promptTokens: Math.max(0, args.after.input - args.before.input),
    completionTokens: Math.max(0, args.after.output - args.before.output),
    totalTokens: Math.max(0, args.after.total - args.before.total),
    cachedTokens: Math.max(0, args.after.cacheRead - args.before.cacheRead),
  };
  // Nothing happened (no tokens, no cost) → skip the row.
  if (d.totalTokens === 0 && d.costUsd === 0) return null;

  const entry: CostEntry = {
    entryId: crypto.randomBytes(16).toString("hex"),
    ts: Date.now() / 1000,
    sessionId: args.sessionId,
    role: args.role ?? "agent",
    model: args.model,
    ...d,
  };
  const file = costsPath(args.sessionId, args.projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

/**
 * Ledger a subagent's spend against its parent session. The subagent runs in a
 * separate in-memory Pi session, so its cost is NOT in the parent's stats — we
 * record it here as a `subagent` row so budgets and totals stay accurate.
 */
export function recordSubagentRun(
  projectId: string,
  sessionId: string,
  model: string,
  stats: { cost: number; tokens: { input: number; output: number; cacheRead: number; total: number } },
): CostEntry | null {
  if (!sessionId) return null;
  return recordRun({
    sessionId,
    projectId,
    model,
    role: "subagent",
    before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
    after: {
      costUsd: stats.cost,
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      total: stats.tokens.total,
    },
  });
}

function readEntries(sessionId: string, projectId?: string): CostEntry[] {
  const file = costsPath(sessionId, projectId);
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CostEntry);
  } catch {
    return [];
  }
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  totalTokens: number;
  agentUsd: number;
  subagentUsd: number;
  entries: CostEntry[];
}

export function sessionCostSummary(sessionId: string, projectId?: string): SessionCostSummary {
  const entries = readEntries(sessionId, projectId);
  let totalUsd = 0;
  let totalTokens = 0;
  let agentUsd = 0;
  let subagentUsd = 0;
  for (const e of entries) {
    totalUsd += e.costUsd;
    totalTokens += e.totalTokens;
    if (e.role === "subagent") subagentUsd += e.costUsd;
    else agentUsd += e.costUsd;
  }
  return { sessionId, totalUsd, totalTokens, agentUsd, subagentUsd, entries };
}

export type BudgetState = "ok" | "warn" | "exceeded";

export interface ProjectCostSummary {
  projectId: string;
  totalUsd: number;
  totalTokens: number;
  sessionCount: number;
  limitUsd: number | null;
  budget: { totalUsd: number; limitUsd: number | null; ratio: number | null; state: BudgetState };
}

/** Sum every session's ledger under a project's runs dir. */
export function projectCostSummary(projectId: string): ProjectCostSummary {
  const paths = resolvePaths(projectId);
  let totalUsd = 0;
  let totalTokens = 0;
  let sessionCount = 0;
  try {
    for (const dirent of fs.readdirSync(paths.runsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      sessionCount++;
      const s = sessionCostSummary(dirent.name, projectId);
      totalUsd += s.totalUsd;
      totalTokens += s.totalTokens;
    }
  } catch {
    /* no runs yet */
  }
  // A null or non-positive limit means "unlimited" (0 is not a hard block).
  const rawLimit = getProject(projectId)?.spendLimitUsd ?? null;
  const limitUsd = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
  const ratio = limitUsd ? totalUsd / limitUsd : null;
  let state: BudgetState = "ok";
  if (ratio !== null) state = ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "warn" : "ok";
  return {
    projectId,
    totalUsd,
    totalTokens,
    sessionCount,
    limitUsd,
    budget: { totalUsd, limitUsd, ratio, state },
  };
}

/** True when the project has a cap and cumulative spend has reached it. */
export function isBudgetExceeded(projectId: string): { exceeded: boolean; totalUsd: number; limitUsd: number | null } {
  const summary = projectCostSummary(projectId);
  // summary.limitUsd is already normalized: null when unlimited (incl. a 0 cap).
  const limit = summary.limitUsd;
  return {
    exceeded: limit !== null && summary.totalUsd >= limit,
    totalUsd: summary.totalUsd,
    limitUsd: limit,
  };
}
