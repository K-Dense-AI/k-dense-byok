/**
 * Pending permission decisions ("may the agent run this destructive command?").
 *
 * Mirrors the interview tool's pending-answer machinery (interview.ts), but is
 * driven from a `tool_call` hook rather than a tool: there is no toolCallId-
 * owned promise or abort signal, so requests mint their own id, ride the run's
 * broker handle as a `permission_request` frame, and are settled by the HTTP
 * route, the run completing (Stop), or a timeout — whichever comes first.
 */
import { randomUUID } from "node:crypto";
import { runBroker } from "./run-broker.ts";

export interface PermissionPayload {
  toolCallId: string;
  toolName: string;
  command: string;
  reason: string;
}

export type PermissionOutcome = "allowed" | "denied" | "timeout" | "cancelled" | "no_ui";

interface PendingPermission {
  projectId: string;
  sessionId: string;
  payload: PermissionPayload;
  settle: (outcome: PermissionOutcome) => void;
}

const pending = new Map<string, PendingPermission>();

export const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_CHARS = 4_000;

/**
 * Ask the user. Resolves to the outcome; never rejects. Without a live run
 * handle (nothing could render the card) the answer is `no_ui`.
 */
export function requestPermission(
  projectId: string,
  sessionId: string,
  payload: PermissionPayload,
  options: { timeoutMs?: number } = {},
): Promise<PermissionOutcome> {
  const handle = runBroker.get(projectId, sessionId);
  if (!handle || handle.isComplete || handle.isAbortRequested) return Promise.resolve("no_ui");
  const requestId = `perm_${randomUUID()}`;
  const trimmed: PermissionPayload = {
    ...payload,
    command: payload.command.length > MAX_COMMAND_CHARS ? `${payload.command.slice(0, MAX_COMMAND_CHARS)}…` : payload.command,
  };
  return new Promise<PermissionOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: PermissionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(requestId);
      if (!handle.isComplete) {
        handle.publish({ type: "permission_resolved", requestId, outcome, allowed: outcome === "allowed" });
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { projectId, sessionId, payload: trimmed, settle: finish });
    // Stop / run end: nobody can answer any more.
    void handle.waitForCompletion().then(() => finish("cancelled"));
    handle.publish({ type: "permission_request", requestId, ...trimmed });
  });
}

/** Answer a pending request. False when none matches (wrong ids, answered, timed out). */
export function resolvePermission(
  projectId: string,
  sessionId: string,
  requestId: string,
  allow: boolean,
): boolean {
  const p = pending.get(requestId);
  if (!p || p.projectId !== projectId || p.sessionId !== sessionId) return false;
  p.settle(allow ? "allowed" : "denied");
  return true;
}

/** Backstop for POST /abort: every card still waiting on this session is dismissed. */
export function cancelPermissionsForSession(projectId: string, sessionId: string): number {
  let cancelled = 0;
  for (const p of [...pending.values()]) {
    if (p.projectId !== projectId || p.sessionId !== sessionId) continue;
    p.settle("cancelled");
    cancelled++;
  }
  return cancelled;
}

/** The pending request for a session, if any (lets a reloading UI re-render it). */
export function pendingPermissionFor(
  projectId: string,
  sessionId: string,
): { requestId: string; payload: PermissionPayload } | null {
  for (const [requestId, p] of pending) {
    if (p.projectId === projectId && p.sessionId === sessionId) return { requestId, payload: p.payload };
  }
  return null;
}
