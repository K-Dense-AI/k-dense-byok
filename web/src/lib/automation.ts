"use client";

/**
 * Automation client: pi-subagents durable schedules and missions for the
 * active project (read via Kady; actions run through the resident scheduler
 * session on the server).
 */
import { apiFetch } from "@/lib/projects";

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

export interface SchedulesResponse {
  schedules: ScheduleView[];
  heldByBudget: string[];
  schedulerSessionId: string | null;
}

async function failure(res: Response, label: string): Promise<Error> {
  const data = (await res.json().catch(() => null)) as { detail?: string } | null;
  return new Error(data?.detail || `${label} ${res.status}`);
}

export async function getSchedules(projectId?: string): Promise<SchedulesResponse> {
  const res = await apiFetch("/schedules", { cache: "no-store" }, projectId);
  if (!res.ok) throw await failure(res, "getSchedules");
  return (await res.json()) as SchedulesResponse;
}

export type ScheduleAction = "pause" | "resume" | "run" | "delete";

export async function scheduleAction(id: string, action: ScheduleAction, projectId?: string): Promise<ScheduleView[]> {
  const res = await apiFetch(`/schedules/${encodeURIComponent(id)}/${action}`, { method: "POST" }, projectId);
  if (!res.ok) throw await failure(res, `schedule ${action}`);
  const data = (await res.json()) as { schedules?: ScheduleView[] };
  return data.schedules ?? [];
}

export async function getMissions(projectId?: string): Promise<MissionView[]> {
  const res = await apiFetch("/missions", { cache: "no-store" }, projectId);
  if (!res.ok) throw await failure(res, "getMissions");
  const data = (await res.json()) as { missions?: MissionView[] };
  return data.missions ?? [];
}

export async function closeMission(id: string, projectId?: string): Promise<MissionView[]> {
  const res = await apiFetch(
    `/missions/${encodeURIComponent(id)}/close`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
    projectId,
  );
  if (!res.ok) throw await failure(res, "closeMission");
  const data = (await res.json()) as { missions?: MissionView[] };
  return data.missions ?? [];
}

/** Human form of a trigger: "every 6h · next 14:00" / "once at …". */
export function describeTrigger(trigger: ScheduleView["trigger"]): string {
  if (trigger.kind === "interval") {
    const next = trigger.nextRunAt ? ` · next ${new Date(trigger.nextRunAt).toLocaleString()}` : "";
    return `every ${trigger.every}${next}`;
  }
  const at = trigger.nextRunAt ?? trigger.at;
  return `once at ${new Date(at).toLocaleString()}`;
}
