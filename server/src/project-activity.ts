import { pendingInterviewFor } from "./agent/interview.ts";
import {
  runBroker,
  type RunActivity,
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
  hasCompletedSession: boolean;
}

export function summarizeProjectActivity({
  runs,
  hasPendingInterview,
  budgetBlocked,
  hasCompletedSession,
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
  const activeOrAttention =
    summary.running > 0 ||
    summary.needsInput > 0 ||
    summary.errors > 0 ||
    summary.blocked > 0;
  if (!activeOrAttention && summary.done === 0 && hasCompletedSession) {
    summary.done = 1;
  }

  return summary;
}

async function activityForProject(projectId: string): Promise<ProjectActivitySummary> {
  const project = getProject(projectId);
  const limit = project?.spendLimitUsd ?? null;
  const budgetBlocked =
    limit !== null &&
    limit > 0 &&
    projectCostSummary(projectId).totalUsd >= limit;
  const sessions = await listSessions(resolvePaths(projectId));

  return summarizeProjectActivity({
    runs: runBroker.activityForProject(projectId),
    hasPendingInterview: (sessionId) =>
      pendingInterviewFor(projectId, sessionId) !== null,
    budgetBlocked,
    hasCompletedSession: sessions.some((session) => session.messageCount > 0),
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
