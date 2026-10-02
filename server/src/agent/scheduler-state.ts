/**
 * Small, dependency-free state file for the scheduler: which resident session
 * hosts a project's pi-subagents schedules and which schedules Kady paused
 * because the project hit its spend cap. Kept apart from scheduler.ts so the
 * sessions route can hide the resident session without importing the
 * scheduler (which imports the registry).
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";

export interface SchedulerState {
  /** Pi session id of the resident host, once created. */
  sessionId?: string;
  /** Schedule ids Kady paused because the project reached its spend limit. */
  heldByBudget: string[];
  updatedAt?: string;
}

export function schedulerStatePath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "scheduler.json");
}

export function readSchedulerState(paths: ProjectPaths): SchedulerState {
  try {
    const raw = JSON.parse(fs.readFileSync(schedulerStatePath(paths), "utf-8")) as Partial<SchedulerState>;
    return {
      ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
      heldByBudget: Array.isArray(raw.heldByBudget) ? raw.heldByBudget.filter((x): x is string => typeof x === "string") : [],
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    };
  } catch {
    return { heldByBudget: [] };
  }
}

export function writeSchedulerState(paths: ProjectPaths, state: SchedulerState): void {
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  const file = schedulerStatePath(paths);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** The resident session id, or null when the project has none yet. */
export function schedulerSessionId(paths: ProjectPaths): string | null {
  return readSchedulerState(paths).sessionId ?? null;
}

// --- schedule run outcomes -----------------------------------------------------
//
// pi-subagents keeps a fire's state but drops its result text on success, and
// quiet fires never reach a visible chat (the resident session is hidden). The
// completion event still carries the runner's summary, so Kady keeps a bounded
// copy keyed by the async run id that the schedule history already records.

export interface ScheduleOutcome {
  asyncId: string;
  scheduleId: string;
  success: boolean;
  summary: string;
  recordedAt: string;
}

const MAX_OUTCOMES = 200;
const MAX_SUMMARY_CHARS = 2_000;

export function scheduleOutcomesPath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "schedule-outcomes.json");
}

export function readScheduleOutcomes(paths: ProjectPaths): ScheduleOutcome[] {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleOutcomesPath(paths), "utf-8")) as { outcomes?: unknown };
    return (Array.isArray(raw.outcomes) ? raw.outcomes : []).filter(
      (o): o is ScheduleOutcome => Boolean(o) && typeof (o as ScheduleOutcome).asyncId === "string" && typeof (o as ScheduleOutcome).summary === "string",
    );
  } catch {
    return [];
  }
}

export function recordScheduleOutcome(paths: ProjectPaths, outcome: Omit<ScheduleOutcome, "recordedAt" | "summary"> & { summary: string }): void {
  const summary = outcome.summary.trim();
  if (!outcome.asyncId || !summary) return;
  const clipped = summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
  const kept = readScheduleOutcomes(paths).filter((o) => o.asyncId !== outcome.asyncId);
  kept.push({ ...outcome, summary: clipped, recordedAt: new Date().toISOString() });
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  const file = scheduleOutcomesPath(paths);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ outcomes: kept.slice(-MAX_OUTCOMES) }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
