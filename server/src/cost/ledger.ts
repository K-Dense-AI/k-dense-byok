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
import {
  billingForProvider,
  normalizeUsageCost,
  type BillingContext,
  type BillingMode,
  type LedgerAuthType,
} from "./billing.ts";

export interface CostSnapshot {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

export function emptySnapshot(): CostSnapshot {
  return { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
}

/** Field-wise `after - before`, clamped at 0. */
export function snapshotDelta(before: CostSnapshot, after: CostSnapshot): CostSnapshot {
  return {
    costUsd: Math.max(0, after.costUsd - before.costUsd),
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    total: Math.max(0, after.total - before.total),
  };
}

/**
 * Field-wise max of two independent measurements of the same run.
 *
 * The stats delta undercounts when compaction shrinks the in-context messages
 * mid-run; the turn_end tally misses a partial turn that errored before
 * turn_end fired. Each lies low in a different failure mode, so the max of
 * the two is the best available estimate of what the run actually spent.
 */
export function snapshotMax(a: CostSnapshot, b: CostSnapshot): CostSnapshot {
  return {
    costUsd: Math.max(a.costUsd, b.costUsd),
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    total: Math.max(a.total, b.total),
  };
}

/** Accumulate one assistant turn's usage (pi-ai `Usage` shape) into a tally. */
export function addTurnUsage(
  tally: CostSnapshot,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  },
): void {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  tally.costUsd += usage.cost?.total ?? 0;
  tally.input += input;
  tally.output += output;
  tally.cacheRead += cacheRead;
  tally.total += input + output + cacheRead + cacheWrite;
}

export interface CostEntry {
  entryId: string;
  ts: number;
  sessionId: string;
  role: "agent" | "subagent" | "compute";
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Billable/estimated USD counted against the project spend cap. */
  costUsd: number;
  provider?: string;
  authType?: LedgerAuthType;
  billingMode?: BillingMode;
  /** Pi list-price equivalent for provider-managed subscription usage. */
  listPriceUsd?: number;
  /** Durable Modal job id. Absent on old rows and non-compute entries. */
  jobId?: string;
  /** Modal costs are estimates (elapsed wall time × catalogue rate). */
  estimated?: boolean;
  terminalState?: string;
}

function inferredBilling(model: string, role?: CostEntry["role"]): BillingContext {
  if (role === "compute" || model === "modal" || model.startsWith("modal/")) {
    return billingForProvider("modal");
  }
  if (model.startsWith("ollama/")) return billingForProvider("ollama", "local");
  if (model.startsWith("openrouter/") || model.startsWith("fusion/")) {
    return billingForProvider("openrouter", "api_key");
  }
  // Legacy rows/callers did not distinguish an OpenRouter vendor prefix from a
  // direct provider. Treat them as payg so missing metadata can never bypass a
  // cap; new callers always pass an explicit context.
  return billingForProvider(model.split("/", 1)[0] || "unknown", "api_key");
}

function costsPath(sessionId: string, projectId?: string): string {
  // The session id becomes a path segment under runsDir; it arrives raw from
  // the URL (Fastify decodes %2F), so reject anything that could traverse.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.runsDir, sessionId, "costs.jsonl");
}

/** Append a ledger row for the delta between two cumulative snapshots. */
export function recordRun(args: {
  sessionId: string;
  model: string;
  before: CostSnapshot;
  after: CostSnapshot;
  role?: "agent" | "subagent" | "compute";
  projectId?: string;
  jobId?: string;
  estimated?: boolean;
  terminalState?: string;
  billing?: BillingContext;
}): CostEntry | null {
  const delta = snapshotDelta(args.before, args.after);
  const billing = args.billing ?? inferredBilling(args.model, args.role);
  const normalizedCost = normalizeUsageCost(delta.costUsd, billing);
  const d = {
    costUsd: normalizedCost.costUsd,
    promptTokens: delta.input,
    completionTokens: delta.output,
    totalTokens: delta.total,
    cachedTokens: delta.cacheRead,
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
    provider: billing.provider,
    authType: billing.authType,
    billingMode: billing.billingMode,
    ...(normalizedCost.listPriceUsd !== undefined
      ? { listPriceUsd: normalizedCost.listPriceUsd }
      : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
    ...(args.estimated !== undefined ? { estimated: args.estimated } : {}),
    ...(args.terminalState ? { terminalState: args.terminalState } : {}),
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
  billing?: BillingContext,
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
    billing,
  });
}

/**
 * Ledger a Modal remote-compute run against its parent session. Modal compute
 * is billed on wall-time × the instance's hourly rate (the `modal_run` tool
 * computes `costUsd` from the instance catalog) and carries no model tokens, so
 * we record it as a `compute` row. It counts toward the project budget exactly
 * like agent/subagent spend.
 */
export function recordModalRun(
  projectId: string,
  sessionId: string,
  costUsd: number,
  model = "modal",
): CostEntry | null {
  if (!sessionId) return null;
  return recordRun({
    sessionId,
    projectId,
    model,
    role: "compute",
    before: emptySnapshot(),
    after: { ...emptySnapshot(), costUsd },
    billing: billingForProvider("modal"),
  });
}

/**
 * Idempotently ledger one durable Modal job. Old rows remain valid because all
 * durable-compute metadata is optional.
 */
export function recordModalJobCost(args: {
  projectId: string;
  sessionId: string;
  jobId: string;
  costUsd: number;
  model: string;
  terminalState: string;
}): CostEntry | null {
  if (!args.sessionId) return null;
  const existing = readEntries(args.sessionId, args.projectId).find(
    (entry) => entry.role === "compute" && entry.jobId === args.jobId,
  );
  if (existing) return existing;
  return recordRun({
    sessionId: args.sessionId,
    projectId: args.projectId,
    model: args.model,
    role: "compute",
    before: emptySnapshot(),
    after: { ...emptySnapshot(), costUsd: Math.max(0, args.costUsd) },
    jobId: args.jobId,
    estimated: true,
    terminalState: args.terminalState,
    billing: billingForProvider("modal"),
  });
}

export interface ComputeReservation {
  version: 1;
  id: string;
  projectId: string;
  sessionId: string;
  amountUsd: number;
  createdAt: number;
}

const RESERVATION_ID_RE = /^[a-z0-9][a-z0-9_-]{5,80}$/;

function reservationPath(projectId: string, reservationId: string): string {
  if (!RESERVATION_ID_RE.test(reservationId)) {
    throw new Error(`Invalid reservation id: ${reservationId}`);
  }
  return path.join(resolvePaths(projectId).modalReservationsDir, `${reservationId}.json`);
}

function writeAtomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listComputeReservations(projectId: string): ComputeReservation[] {
  const dir = resolvePaths(projectId).modalReservationsDir;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as ComputeReservation;
      if (
        value?.version === 1 &&
        value.projectId === projectId &&
        Number.isFinite(value.amountUsd) &&
        value.amountUsd >= 0
      ) {
        return [value];
      }
    } catch {
      // A malformed reservation is ignored rather than making every project
      // request fail. Atomic writers ensure normal files are never partial.
    }
    return [];
  });
}

/**
 * Reserve the strict worst-case cost before a remote job is admitted.
 *
 * This function is synchronous on purpose: in one server process, no other
 * submit can interleave between the committed-spend check and atomic write.
 */
export function reserveComputeBudget(args: {
  projectId: string;
  reservationId: string;
  sessionId: string;
  amountUsd: number;
}): ComputeReservation {
  if (!Number.isFinite(args.amountUsd) || args.amountUsd < 0) {
    throw new Error("Reservation amount must be a non-negative finite number");
  }
  const file = reservationPath(args.projectId, args.reservationId);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ComputeReservation;
  } catch {
    // new reservation
  }
  const summary = projectCostSummary(args.projectId);
  if (
    summary.limitUsd !== null &&
    summary.committedUsd + args.amountUsd > summary.limitUsd + Number.EPSILON
  ) {
    const error = new Error(
      `Modal job would exceed the project spend limit: ` +
        `$${summary.committedUsd.toFixed(4)} committed + ` +
        `$${args.amountUsd.toFixed(4)} reserved > $${summary.limitUsd.toFixed(4)}`,
    );
    error.name = "BudgetReservationError";
    throw error;
  }
  const reservation: ComputeReservation = {
    version: 1,
    id: args.reservationId,
    projectId: args.projectId,
    sessionId: args.sessionId,
    amountUsd: args.amountUsd,
    createdAt: Date.now(),
  };
  writeAtomicJson(file, reservation);
  return reservation;
}

export function releaseComputeReservation(projectId: string, reservationId: string): void {
  fs.rmSync(reservationPath(projectId, reservationId), { force: true });
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

/**
 * Move a durable Modal cost row from a child/synthetic session to its parent.
 * Project totals remain unchanged; the operation is idempotent and uses an
 * atomic rewrite so readers never observe a partial source ledger.
 */
export function reattributeModalJobCost(
  projectId: string,
  jobId: string,
  fromSessionId: string,
  toSessionId: string,
): boolean {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return false;
  const source = readEntries(fromSessionId, projectId);
  const entry = source.find((row) => row.role === "compute" && row.jobId === jobId);
  if (!entry) return false;
  if (
    readEntries(toSessionId, projectId).some(
      (row) => row.role === "compute" && row.jobId === jobId,
    )
  ) {
    return false;
  }
  const sourceFile = costsPath(fromSessionId, projectId);
  const kept = source.filter((row) => row.entryId !== entry.entryId);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  const tmp = `${sourceFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length ? "\n" : ""),
    { encoding: "utf-8", mode: 0o600 },
  );
  fs.renameSync(tmp, sourceFile);

  const targetFile = costsPath(toSessionId, projectId);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.appendFileSync(
    targetFile,
    JSON.stringify({ ...entry, sessionId: toSessionId }) + "\n",
    "utf-8",
  );
  return true;
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  listPriceUsd: number;
  subscriptionTokens: number;
  totalTokens: number;
  agentUsd: number;
  subagentUsd: number;
  computeUsd: number;
  entries: CostEntry[];
}

export function sessionCostSummary(sessionId: string, projectId?: string): SessionCostSummary {
  const entries = readEntries(sessionId, projectId);
  let totalUsd = 0;
  let listPriceUsd = 0;
  let subscriptionTokens = 0;
  let totalTokens = 0;
  let agentUsd = 0;
  let subagentUsd = 0;
  let computeUsd = 0;
  for (const e of entries) {
    totalUsd += e.costUsd;
    listPriceUsd += e.listPriceUsd ?? 0;
    if (e.billingMode === "subscription") subscriptionTokens += e.totalTokens;
    totalTokens += e.totalTokens;
    if (e.role === "subagent") subagentUsd += e.costUsd;
    else if (e.role === "compute") computeUsd += e.costUsd;
    else agentUsd += e.costUsd;
  }
  return {
    sessionId,
    totalUsd,
    listPriceUsd,
    subscriptionTokens,
    totalTokens,
    agentUsd,
    subagentUsd,
    computeUsd,
    entries,
  };
}

export type BudgetState = "ok" | "warn" | "exceeded";

export interface ProjectCostSummary {
  projectId: string;
  /** Backward-compatible alias for money already ledgered. */
  totalUsd: number;
  spentUsd: number;
  reservedUsd: number;
  committedUsd: number;
  listPriceUsd: number;
  subscriptionTokens: number;
  totalTokens: number;
  sessionCount: number;
  limitUsd: number | null;
  budget: {
    /** Includes active reservations so admission and summaries agree. */
    totalUsd: number;
    spentUsd: number;
    reservedUsd: number;
    committedUsd: number;
    limitUsd: number | null;
    ratio: number | null;
    state: BudgetState;
  };
}

/** Sum every session's ledger under a project's runs dir. */
export function projectCostSummary(projectId: string): ProjectCostSummary {
  const paths = resolvePaths(projectId);
  let totalUsd = 0;
  let listPriceUsd = 0;
  let subscriptionTokens = 0;
  let totalTokens = 0;
  let sessionCount = 0;
  try {
    for (const dirent of fs.readdirSync(paths.runsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const s = sessionCostSummary(dirent.name, projectId);
      if (s.entries.length === 0) continue; // run dir with nothing ledgered yet
      sessionCount++;
      totalUsd += s.totalUsd;
      listPriceUsd += s.listPriceUsd;
      subscriptionTokens += s.subscriptionTokens;
      totalTokens += s.totalTokens;
    }
  } catch {
    /* no runs yet */
  }
  // A null or non-positive limit means "unlimited" (0 is not a hard block).
  const rawLimit = getProject(projectId)?.spendLimitUsd ?? null;
  const limitUsd = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
  const reservedUsd = listComputeReservations(projectId).reduce(
    (sum, reservation) => sum + reservation.amountUsd,
    0,
  );
  const committedUsd = totalUsd + reservedUsd;
  const ratio = limitUsd ? committedUsd / limitUsd : null;
  let state: BudgetState = "ok";
  if (ratio !== null) state = ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "warn" : "ok";
  return {
    projectId,
    totalUsd,
    spentUsd: totalUsd,
    reservedUsd,
    committedUsd,
    listPriceUsd,
    subscriptionTokens,
    totalTokens,
    sessionCount,
    limitUsd,
    budget: {
      totalUsd: committedUsd,
      spentUsd: totalUsd,
      reservedUsd,
      committedUsd,
      limitUsd,
      ratio,
      state,
    },
  };
}

/** True when the project has a cap and cumulative spend has reached it. */
export function isBudgetExceeded(projectId: string): { exceeded: boolean; totalUsd: number; limitUsd: number | null } {
  const summary = projectCostSummary(projectId);
  // summary.limitUsd is already normalized: null when unlimited (incl. a 0 cap).
  const limit = summary.limitUsd;
  return {
    exceeded: limit !== null && summary.committedUsd >= limit,
    totalUsd: summary.committedUsd,
    limitUsd: limit,
  };
}
