import fs from "node:fs";
import { pendingInterviewFor } from "./agent/interview.ts";
import {
  runBroker,
  type RunActivity,
  type RunActivityState,
} from "./agent/run-broker.ts";
import { listSessions } from "./agent/session-registry.ts";
import { projectCostSummary } from "./cost/ledger.ts";
import {
  getProject,
  listProjects,
  resolvePaths,
} from "./projects.ts";

export interface ProjectActivitySummary {
  running: number;
  needsInput: number;
  errors: number;
  blocked: number;
  done: number;
}

export interface ProjectActivityInputs {
  runs: readonly RunActivity[];
  hasPendingInterview: (sessionId: string) => boolean;
  budgetBlocked: boolean;
}

export function summarizeProjectActivity({
  runs,
  hasPendingInterview,
  budgetBlocked,
}: ProjectActivityInputs): ProjectActivitySummary {
  const summary: ProjectActivitySummary = {
    running: 0,
    needsInput: 0,
    errors: 0,
    blocked: 0,
    done: 0,
  };

  for (const run of runs) {
    if (run.state === "running" && hasPendingInterview(run.sessionId)) {
      summary.needsInput++;
    } else if (run.state === "running") {
      summary.running++;
    } else if (run.state === "error") {
      summary.errors++;
    } else if (run.state === "blocked") {
      summary.blocked++;
    } else {
      summary.done++;
    }
  }

  if (budgetBlocked) summary.blocked = Math.max(summary.blocked, 1);
  return summary;
}

type ListedSession = Awaited<ReturnType<typeof listSessions>>[number];
const historicalOutcomeCache = new Map<
  string,
  { modifiedMs: number; state: RunActivityState | null }
>();

/**
 * Reconstruct only the newest session's terminal outcome. A final assistant
 * `stop`/`length` is durable evidence of completion; tool-use, abort, or a
 * missing stop reason is not. This avoids labeling every old non-empty chat as
 * "Done" while still restoring a meaningful project status after restart.
 */
function historicalOutcome(session: ListedSession): RunActivityState | null {
  const modifiedMs = session.modified.getTime();
  const cached = historicalOutcomeCache.get(session.path);
  if (cached?.modifiedMs === modifiedMs) return cached.state;

  let state: RunActivityState | null = null;
  try {
    const lines = fs.readFileSync(session.path, "utf-8").trimEnd().split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const entry = JSON.parse(lines[index]) as {
        type?: unknown;
        message?: { role?: unknown; stopReason?: unknown };
      };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const reason = entry.message.stopReason;
      if (reason === "error") state = "error";
      else if (reason !== "aborted" && reason !== "toolUse" && typeof reason === "string") {
        state = "done";
      }
      break;
    }
  } catch {
    state = null;
  }
  historicalOutcomeCache.set(session.path, { modifiedMs, state });
  return state;
}

async function activityForProject(projectId: string): Promise<ProjectActivitySummary> {
  const project = getProject(projectId);
  const limit = project?.spendLimitUsd ?? null;
  const budgetBlocked =
    limit !== null &&
    limit > 0 &&
    projectCostSummary(projectId).totalUsd >= limit;
  const sessions = await listSessions(resolvePaths(projectId));
  const retained = runBroker.activityForProject(projectId);
  const newestSession = sessions
    .filter((session) => session.messageCount > 0)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
  const persistedState =
    retained.length === 0 && newestSession
      ? historicalOutcome(newestSession)
      : null;
  const runs = persistedState
    ? [{ sessionId: newestSession.id, state: persistedState }, ...retained]
    : retained;

  return summarizeProjectActivity({
    runs,
    hasPendingInterview: (sessionId) =>
      pendingInterviewFor(projectId, sessionId) !== null,
    budgetBlocked,
  });
}

export async function listProjectActivities(): Promise<
  Record<string, ProjectActivitySummary>
> {
  const projects = listProjects();
  const entries = await Promise.all(
    projects.map(async (project) => [
      project.id,
      await activityForProject(project.id),
    ] as const),
  );
  return Object.fromEntries(entries);
}
