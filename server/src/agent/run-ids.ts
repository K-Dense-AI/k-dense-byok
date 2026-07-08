/**
 * Per-session run-id context. POST /sessions/:id/run mints one id per
 * invocation and stashes it here so append-time consumers — the lead agent's
 * notebook tool and the subagent notebook harvest — can stamp entries with
 * the run they belong to. Mirrors the sessionComputeTargets holder in
 * modal-tool.ts (module-level map keyed by Pi sessionId).
 *
 * Known limitation (accepted): an async/background subagent that completes
 * while a LATER run of the same session is in flight gets that later run's id
 * — the completion payload carries no correlation to the run that spawned it.
 */
import { randomUUID } from "node:crypto";

const sessionRunIds = new Map<string, string>();

/** Mint a unique id for one POST /sessions/:id/run invocation. */
export function mintRunId(): string {
  return `run_${randomUUID()}`;
}

/** Stash/clear the in-flight run id for a session (null clears). */
export function setSessionRunId(sessionId: string, runId: string | null): void {
  if (runId === null) sessionRunIds.delete(sessionId);
  else sessionRunIds.set(sessionId, runId);
}

/** The in-flight run id for a session, or undefined when no run is live. */
export function currentRunId(sessionId: string): string | undefined {
  return sessionRunIds.get(sessionId);
}
