/**
 * Per-project/session run-id context. POST /sessions/:id/run mints one id per
 * invocation and stashes it here so append-time consumers — the lead agent's
 * notebook tool and the subagent notebook harvest — can stamp entries with
 * the run they belong to. Mirrors the sessionComputeTargets holder in
 * modal-tool.ts.
 *
 * Async notebook harvest deliberately does not consult this holder: a later
 * active run is not the originating run. Until durable launch correlation is
 * available, those notebook entries remain unstamped.
 */
import { randomUUID } from "node:crypto";

const sessionRunIds = new Map<string, string>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

/** Mint a unique id for one POST /sessions/:id/run invocation. */
export function mintRunId(): string {
  return `run_${randomUUID()}`;
}

/** Stash/clear the in-flight run id for a project session (null clears). */
export function setSessionRunId(
  projectId: string,
  sessionId: string,
  runId: string | null,
): void {
  const key = keyFor(projectId, sessionId);
  if (runId === null) sessionRunIds.delete(key);
  else sessionRunIds.set(key, runId);
}

/** The in-flight run id for a project session, or undefined when none is live. */
export function currentRunId(projectId: string, sessionId: string): string | undefined {
  return sessionRunIds.get(keyFor(projectId, sessionId));
}
