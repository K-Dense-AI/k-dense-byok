/**
 * Kady chat sessions are headless to Pi, so pi-subagents would hold every
 * turn's agent_end open until all background work drains. The
 * KADY_HOST_NO_DRAIN_V1 seam lets the turn end (completions arrive later as
 * system runs); other headless sessions keep the plugin's drain.
 */
import { afterEach, expect, it } from "vitest";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { ensureProjectExists } from "../src/projects.ts";
import { createSession, disposeProjectSessions } from "../src/agent/session-registry.ts";

const projectId = "no-drain";
const disposers: Array<() => void> = [];
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  await disposeProjectSessions(projectId);
});

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

it("ends a chat turn while background work is still running", async () => {
  const session = await createSession(projectId, ensureProjectExists(projectId));
  // pi-subagents identifies sessions by their file (shared/session-identity.js).
  const owner = session.sessionFile ?? session.sessionId;
  const interactive = (globalThis as { __kadyInteractiveSessions?: Set<string> }).__kadyInteractiveSessions;
  expect(interactive?.has(owner)).toBe(true);
  // Work the plugin would otherwise wait for, e.g. a running async specialist.
  let active = true;
  disposers.push(registerBackgroundWorkProvider({
    name: "test-work",
    listActiveWork: (context) => (active && context?.sessionId === owner ? [{ id: "job-1", sessionId: owner }] : []),
  }));
  expect(await settledWithin(session.extensionRunner.emit({ type: "agent_end", messages: [] }), 2_000)).toBe(true);

  // Control: the same session treated as a plain headless session drains first.
  interactive!.delete(owner);
  const draining = session.extensionRunner.emit({ type: "agent_end", messages: [] });
  expect(await settledWithin(draining, 500)).toBe(false);
  active = false;
  interactive!.add(owner);
  await expect(settledWithin(draining, 10_000)).resolves.toBe(true);
}, 30_000);
