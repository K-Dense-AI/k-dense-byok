/** Read-time enrichment only; approval history never comes from notebook tool arguments. */
import type { NotebookEntry } from "./notebook-store.ts";
import { readAnalysisPlans } from "./notebook-plans.ts";

export function withNotebookPlanHistory<T extends NotebookEntry & { sessionId?: string }>(entries: T[], projectId: string, sessionId?: string): T[] {
  return entries.map((entry) => {
    const { planHistory: _untrusted, planHistoryError: _error, ...rest } = entry;
    const sid = entry.sessionId ?? sessionId;
    if (entry.type !== "hypothesis" || !sid) return rest as T;
    try {
      const history = readAnalysisPlans(projectId, { sessionId: sid, entryId: entry.id });
      return { ...rest, ...(history.events.length ? { planHistory: history } : {}) } as T;
    } catch (error) {
      return { ...rest, planHistoryError: (error as Error).message } as T;
    }
  });
}
