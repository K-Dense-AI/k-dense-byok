/**
 * Server-owned scheduling for pi-subagents' durable schedules.
 *
 * pi-subagents arms a schedule's timers inside whichever live Pi session
 * loads the extension, and Kady sessions live only while a chat tab holds
 * them (≤10 per project, LRU-evicted, gone on restart). Left alone, a
 * "nightly QC" schedule fires only while someone happens to have a tab open.
 *
 * This module keeps one **resident session** per project that has active
 * schedules (id recorded in `.kady/scheduler.json`, marked as a system session
 * so it is never evicted and costs no tab slot, hidden from the chat list).
 * Its extension instance owns the timers; completions flow through the same
 * async-complete hooks as any delegation (ledger with `origin.schedule`,
 * notebook and provenance harvest), and completion notices become system runs
 * on that session through the observer.
 *
 * Panel actions and the budget hold call the `subagent` tool's `execute`
 * directly on the resident session — no model in the loop. A fire itself
 * bypasses every tool_call gate, so when the project cap is reached the tick
 * pauses active schedules (recorded as `heldByBudget`) and resumes them once
 * the cap clears.
 *
 * Reads of pi-subagents' store (`sandbox/.pi/subagents/schedules/<id>/`) are
 * read-only and follow the documented file shapes.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isBudgetExceeded, scheduleSpend } from "../cost/ledger.ts";
import { listProjects, resolvePaths, type ProjectPaths } from "../projects.ts";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import { createSession, getSession, markSystemSession } from "./session-registry.ts";
import { readSchedulerState, writeSchedulerState } from "./scheduler-state.ts";

export interface ScheduleView {
  id: string;
  name: string;
  trigger:
    | { kind: "once"; at: string; nextRunAt?: string }
    | { kind: "interval"; every: string; everyMs: number; anchorAt: string; nextRunAt: string };
  workflowScript: string;
  baseRef?: string;
  paused: boolean;
  heldByBudget: boolean;
  catchUp: "none" | "latest";
  timeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  lastRun?: ScheduleRunView;
  runs: ScheduleRunView[];
  spendUsd: number;
}

export interface ScheduleRunView {
  id: string;
  plannedAt: string;
  dueReason: "timer" | "run-due" | "manual";
  state: "running" | "skipped" | "missed" | "completed" | "failed_launch" | "failed_run";
  startedAt?: string;
  completedAt?: string;
  asyncId?: string;
  error?: string;
}

export interface MissionView {
  id: string;
  title: string;
  objective: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  goal?: { status: string };
  budget?: { tokens: number };
  usage?: { tokens: number };
  runs: Array<{ runId: string; mode: string; agent?: string; status?: string; startedAt?: string; completedAt?: string }>;
  decisions: Array<{ id: string; status: string; title: string }>;
  receipts: Array<{ kind: string; status: string; title: string; url: string }>;
  summary?: string;
  labels?: string[];
}

const MAX_RUNS_PER_SCHEDULE = 20;
const MAX_MISSIONS = 200;
const TICK_MS = 60_000;

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const readJson = (file: string): Rec | null => {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
};

export function schedulesDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "subagents", "schedules");
}

/** Read-only view of pi-subagents' schedule store plus Kady's hold state and spend. */
export function listSchedules(projectId: string): ScheduleView[] {
  const paths = resolvePaths(projectId);
  const dir = schedulesDir(paths);
  if (!fs.existsSync(dir)) return [];
  const held = new Set(readSchedulerState(paths).heldByBudget);
  const spend = scheduleSpend(projectId);
  const out: ScheduleView[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readJson(path.join(dir, entry.name, "schedule.json"));
    if (!record || typeof record.id !== "string") continue;
    const history = readJson(path.join(dir, entry.name, "history.json"));
    const runs = (Array.isArray(history?.runs) ? history!.runs : [])
      .map((r) => asRecord(r))
      .filter((r) => typeof r.id === "string")
      .slice(0, MAX_RUNS_PER_SCHEDULE)
      .map(
        (r): ScheduleRunView => ({
          id: r.id as string,
          plannedAt: String(r.plannedAt ?? ""),
          dueReason: (r.dueReason as ScheduleRunView["dueReason"]) ?? "timer",
          state: (r.state as ScheduleRunView["state"]) ?? "completed",
          ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
          ...(typeof r.completedAt === "string" ? { completedAt: r.completedAt } : {}),
          ...(typeof r.asyncId === "string" ? { asyncId: r.asyncId } : {}),
          ...(typeof r.error === "string" ? { error: r.error } : {}),
        }),
      );
    const target = asRecord(record.target);
    out.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      trigger: asRecord(record.trigger) as ScheduleView["trigger"],
      workflowScript: typeof target.workflowScript === "string" ? target.workflowScript : "",
      ...(typeof target.baseRef === "string" ? { baseRef: target.baseRef } : {}),
      paused: record.paused === true,
      heldByBudget: held.has(record.id),
      catchUp: record.catchUp === "none" ? "none" : "latest",
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
      createdAt: String(record.createdAt ?? ""),
      updatedAt: String(record.updatedAt ?? ""),
      ...(typeof record.activeRunId === "string" ? { activeRunId: record.activeRunId } : {}),
      ...(runs[0] ? { lastRun: runs[0] } : {}),
      runs,
      spendUsd: spend[record.id] ?? 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** pi-subagents stores missions under `<agentDir>/missions/projects/<sha256(cwd)>/<id>.json`. */
export function missionsDir(paths: ProjectPaths, agentDir = KADY_PI_AGENT_DIR): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hash = createHash("sha256").update(path.resolve(paths.sandbox)).digest("hex");
  return path.join(agentDir, "missions", "projects", hash);
}

export function listMissions(projectId: string, agentDir = KADY_PI_AGENT_DIR): MissionView[] {
  const dir = missionsDir(resolvePaths(projectId), agentDir);
  if (!fs.existsSync(dir)) return [];
  const out: MissionView[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const m = readJson(path.join(dir, entry.name));
    if (!m || typeof m.id !== "string") continue;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => asRecord(x)) : []);
    out.push({
      id: m.id,
      title: String(m.title ?? m.id),
      objective: String(m.objective ?? ""),
      status: String(m.status ?? "unknown"),
      createdAt: String(m.createdAt ?? ""),
      updatedAt: String(m.updatedAt ?? ""),
      ...(m.goal ? { goal: { status: String(asRecord(m.goal).status ?? "active") } } : {}),
      ...(typeof asRecord(m.budget).tokens === "number" ? { budget: { tokens: asRecord(m.budget).tokens as number } } : {}),
      ...(typeof asRecord(m.usage).tokens === "number" ? { usage: { tokens: asRecord(m.usage).tokens as number } } : {}),
      runs: arr(m.runs).map((r) => ({
        runId: String(r.runId ?? ""),
        mode: String(r.mode ?? ""),
        ...(typeof r.agent === "string" ? { agent: r.agent } : {}),
        ...(typeof r.status === "string" ? { status: r.status } : {}),
        ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
        ...(typeof r.completedAt === "string" ? { completedAt: r.completedAt } : {}),
      })),
      decisions: arr(m.decisions).map((d) => ({ id: String(d.id ?? ""), status: String(d.status ?? ""), title: String(d.title ?? "") })),
      receipts: arr(m.receipts).map((r) => ({ kind: String(r.kind ?? ""), status: String(r.status ?? ""), title: String(r.title ?? ""), url: String(r.url ?? "") })),
      ...(typeof m.summary === "string" ? { summary: m.summary } : {}),
      ...(Array.isArray(m.labels) ? { labels: m.labels.map(String) } : {}),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_MISSIONS);
}

// --- resident session ---------------------------------------------------------

type ToolLike = { name: string; execute: (id: string, params: unknown) => Promise<{ content?: unknown; details?: unknown }> };

export interface SchedulerDeps {
  /** Injectable for tests: open/create the resident session. */
  openSession?: (projectId: string, paths: ProjectPaths, sessionId: string | null) => Promise<AgentSession | null>;
  invoke?: (projectId: string, params: Record<string, unknown>) => Promise<{ text: string; details: unknown }>;
  log?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

const deps: Required<Pick<SchedulerDeps, "openSession" | "invoke">> & { log: NonNullable<SchedulerDeps["log"]> } = {
  openSession: defaultOpenSession,
  invoke: defaultInvoke,
  log: console,
};

export function configureScheduler(overrides: SchedulerDeps): void {
  if (overrides.openSession) deps.openSession = overrides.openSession;
  if (overrides.invoke) deps.invoke = overrides.invoke;
  if (overrides.log) deps.log = overrides.log;
}

async function defaultOpenSession(projectId: string, paths: ProjectPaths, sessionId: string | null): Promise<AgentSession | null> {
  if (sessionId) {
    const existing = await getSession(projectId, paths, sessionId);
    if (existing) return existing;
  }
  return createSession(projectId, paths);
}

const ensuring = new Map<string, Promise<AgentSession | null>>();

/**
 * Open (or create) the project's resident session and mark it as a system
 * session. Idempotent and de-duplicated per project.
 */
export function ensureSchedulerSession(projectId: string): Promise<AgentSession | null> {
  const inFlight = ensuring.get(projectId);
  if (inFlight) return inFlight;
  const promise = (async () => {
    const paths = resolvePaths(projectId);
    const state = readSchedulerState(paths);
    const session = await deps.openSession(projectId, paths, state.sessionId ?? null);
    if (!session) return null;
    markSystemSession(projectId, session.sessionId);
    if (state.sessionId !== session.sessionId) writeSchedulerState(paths, { ...state, sessionId: session.sessionId });
    return session;
  })().finally(() => ensuring.delete(projectId));
  ensuring.set(projectId, promise);
  return promise;
}

/** Call the `subagent` tool directly on the resident session (no model). */
async function defaultInvoke(projectId: string, params: Record<string, unknown>): Promise<{ text: string; details: unknown }> {
  const session = await ensureSchedulerSession(projectId);
  if (!session) throw new Error("The scheduler session could not be opened");
  const tool = (session.agent.state.tools as unknown as ToolLike[]).find((t) => t.name === "subagent");
  if (!tool) throw new Error("The subagent tool is not available in the scheduler session");
  const result = await tool.execute(`kady_${randomUUID()}`, params);
  const text = Array.isArray(result.content)
    ? result.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
    : "";
  return { text, details: result.details };
}

export function invokeSubagentAction(projectId: string, params: Record<string, unknown>): Promise<{ text: string; details: unknown }> {
  return deps.invoke(projectId, params);
}

/** Projects whose schedule store holds at least one non-paused schedule. */
export function projectsWithActiveSchedules(): string[] {
  return listProjects()
    .filter((p) => !p.archived)
    .map((p) => p.id)
    .filter((id) => listSchedules(id).some((s) => !s.paused));
}

/** At boot: give every project with active schedules its resident session. */
export async function bootSchedulerSessions(): Promise<string[]> {
  const started: string[] = [];
  for (const projectId of projectsWithActiveSchedules()) {
    try {
      if (await ensureSchedulerSession(projectId)) started.push(projectId);
    } catch (err) {
      deps.log.warn({ err, projectId }, "could not open the scheduler session");
    }
  }
  return started;
}

/**
 * Budget hold: pause active schedules while the project is over its cap and
 * resume the ones Kady paused once it clears. Returns what changed.
 */
export async function reconcileBudgetHolds(projectId: string): Promise<{ held: string[]; released: string[] }> {
  const paths = resolvePaths(projectId);
  const state = readSchedulerState(paths);
  const schedules = listSchedules(projectId);
  if (schedules.length === 0 && state.heldByBudget.length === 0) return { held: [], released: [] };
  const exceeded = isBudgetExceeded(projectId).exceeded;
  const held: string[] = [];
  const released: string[] = [];
  const nextHeld = new Set(state.heldByBudget);
  if (exceeded) {
    for (const schedule of schedules) {
      if (schedule.paused || nextHeld.has(schedule.id)) continue;
      try {
        await deps.invoke(projectId, { action: "schedule.pause", id: schedule.id });
        nextHeld.add(schedule.id);
        held.push(schedule.id);
      } catch (err) {
        deps.log.warn({ err, projectId, scheduleId: schedule.id }, "could not pause schedule over budget");
      }
    }
  } else {
    for (const id of [...nextHeld]) {
      try {
        if (schedules.some((s) => s.id === id)) await deps.invoke(projectId, { action: "schedule.resume", id });
        nextHeld.delete(id);
        released.push(id);
      } catch (err) {
        deps.log.warn({ err, projectId, scheduleId: id }, "could not resume schedule after budget cleared");
      }
    }
  }
  if (held.length || released.length) writeSchedulerState(paths, { ...state, heldByBudget: [...nextHeld] });
  return { held, released };
}

let tick: NodeJS.Timeout | null = null;

/** Start the periodic budget-hold reconciliation; returns a stop function. */
export function startSchedulerTick(intervalMs = TICK_MS): () => void {
  stopSchedulerTick();
  const run = async () => {
    for (const projectId of listProjects().filter((p) => !p.archived).map((p) => p.id)) {
      try {
        await reconcileBudgetHolds(projectId);
      } catch (err) {
        deps.log.warn({ err, projectId }, "scheduler tick failed");
      }
    }
  };
  tick = setInterval(() => void run(), intervalMs);
  tick.unref?.();
  return stopSchedulerTick;
}

export function stopSchedulerTick(): void {
  if (tick) clearInterval(tick);
  tick = null;
}

/** Hook for the subagent bridge: creating/resuming/running a schedule needs a host. */
export function onScheduleActivity(projectId: string): void {
  void ensureSchedulerSession(projectId).catch((err) => deps.log.warn({ err, projectId }, "could not open the scheduler session"));
}
