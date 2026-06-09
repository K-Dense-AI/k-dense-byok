/**
 * Request-scoped "active project", the TS equivalent of the Python
 * `ACTIVE_PROJECT` ContextVar. We use AsyncLocalStorage so any code reached
 * during a request (route handlers, agent runs) can resolve the right project
 * paths via `currentProjectId()` without threading the id through every call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_PROJECT_ID } from "./config.ts";

const storage = new AsyncLocalStorage<{ projectId: string }>();

/** Run `fn` with the given project marked active for its async subtree. */
export function withActiveProject<T>(projectId: string, fn: () => T): T {
  return storage.run({ projectId }, fn);
}

export function currentProjectId(): string {
  return storage.getStore()?.projectId ?? DEFAULT_PROJECT_ID;
}
