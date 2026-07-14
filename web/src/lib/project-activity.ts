import type { AgentRunState } from "./use-agent";

export interface ProjectTabActivity {
  isStreaming: boolean;
  runState: AgentRunState;
  needsInput: boolean;
}

export interface ProjectActivitySummary {
  running: number;
  needsInput: number;
  errors: number;
  blocked: number;
  done: number;
}

export function summarizeProjectActivity(
  tabs: readonly ProjectTabActivity[],
  budgetBlocked: boolean,
): ProjectActivitySummary {
  const summary: ProjectActivitySummary = {
    running: 0,
    needsInput: 0,
    errors: 0,
    blocked: 0,
    done: 0,
  };

  for (const tab of tabs) {
    if (tab.needsInput) summary.needsInput++;
    else if (tab.isStreaming && tab.runState === "running") summary.running++;

    if (tab.runState === "error") summary.errors++;
    else if (tab.runState === "blocked") summary.blocked++;
    else if (tab.runState === "done") summary.done++;
  }

  if (budgetBlocked) summary.blocked = Math.max(summary.blocked, 1);
  return summary;
}

export function hasProjectActivity(summary: ProjectActivitySummary): boolean {
  return Object.values(summary).some((count) => count > 0);
}

export function sameProjectActivity(
  a: ProjectActivitySummary | undefined,
  b: ProjectActivitySummary,
): boolean {
  return Boolean(
    a &&
      a.running === b.running &&
      a.needsInput === b.needsInput &&
      a.errors === b.errors &&
      a.blocked === b.blocked &&
      a.done === b.done,
  );
}
