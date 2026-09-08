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
