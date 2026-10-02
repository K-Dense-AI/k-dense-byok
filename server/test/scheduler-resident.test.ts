import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ensureProjectExists } from "../src/projects.ts";
import { createSession, disposeProjectSessions, disposeSession } from "../src/agent/session-registry.ts";
import { ensureSchedulerSession, listSchedules, onScheduleActivity, reconcileBudgetHolds } from "../src/agent/scheduler.ts";
import { setScheduleActivityListener } from "../src/agent/subagent-bridge.ts";

const projectId = "scheduler-resident-regression";
afterEach(async () => {
  await disposeProjectSessions(projectId);
  setScheduleActivityListener(null);
  vi.restoreAllMocks();
});

/** Since pi-subagents 0.74 the model writes the script in a ```js workflow
 *  block of the same reply; Pi persists that reply before its tools run. */
function reply(session: AgentSession, id: string, input: Record<string, unknown>, script: string) {
  session.sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Scheduling it.\n```js workflow\n" + script + "\n```" },
      { type: "toolCall", id, name: "subagent", arguments: input },
    ],
    api: "openai-completions", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
}

async function action(session: AgentSession, input: Record<string, unknown>, script?: string) {
  const id = `test-${String(input.action)}-${session.sessionId}`;
  if (script !== undefined) reply(session, id, input, script);
  const blocked = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "subagent", toolCallId: id, input });
  expect(blocked?.block).not.toBe(true);
  const tool = session.agent.state.tools.find((t) => t.name === "subagent")!;
  const result = await tool.execute(id, input);
  expect(result.isError).not.toBe(true);
  const updated = await session.extensionRunner.emitToolResult({
    type: "tool_result", toolName: "subagent", toolCallId: id, input,
    content: result.content, details: result.details, isError: result.isError === true,
  });
  expect(updated?.isError).not.toBe(true);
}

describe("resident schedule ownership with real Pi sessions", () => {
  it("adopts later schedules and resumes with exactly one timer after chat disposal", async () => {
    const paths = ensureProjectExists(projectId);
    fs.rmSync(`${paths.sandbox}/.pi/subagents/schedules`, { recursive: true, force: true });
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const armed = new Set<ReturnType<typeof setTimeout>>();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = originalSet(fn, delay, ...args);
      if (new Error().stack?.includes("ScheduledRunManager.arm")) armed.add(timer);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      armed.delete(timer as ReturnType<typeof setTimeout>);
      originalClear(timer);
    });
    setScheduleActivityListener(onScheduleActivity);
    await ensureSchedulerSession(projectId);
    const chat = await createSession(projectId, paths);
    await action(chat, { action: "schedule.create", id: "later", every: "24h", workflow: true },
      'return runs.run("main", { agent: "worker", task: "No-op" })');
    expect(listSchedules(projectId)).toMatchObject([{ id: "later", workflowScript: expect.stringContaining('agent: "worker"') }]);
    expect(armed.size).toBe(1); // the resident owns it; the chat must not also arm it
    await action(chat, { action: "schedule.pause", id: "later" });
    expect(armed.size).toBe(0);
    await action(chat, { action: "schedule.resume", id: "later" });
    expect(armed.size).toBe(1);
    await disposeSession(projectId, chat.sessionId);
    await reconcileBudgetHolds(projectId);
    expect(listSchedules(projectId)).toMatchObject([{ id: "later", paused: false }]);
    expect(armed.size).toBe(1);
    const host = await ensureSchedulerSession(projectId);
    await action(host!, { action: "schedule.delete", id: "later" });
    expect(armed.size).toBe(0);
    expect(listSchedules(projectId)).toEqual([]);

    // Explicitly session-only automation retains its original chat ownership.
    const scopedChat = await createSession(projectId, paths);
    fs.writeFileSync(`${paths.sandbox}/nightly.js`, 'return runs.run("main", { agent: "worker", task: "No-op" })');
    await action(scopedChat, {
      action: "schedule.create", id: "session-only", every: "24h", sessionOnly: true, workflow: "./nightly.js",
    });
    fs.rmSync(`${paths.sandbox}/nightly.js`);
    await ensureSchedulerSession(projectId);
    expect(armed.size).toBe(1);
    await disposeSession(projectId, scopedChat.sessionId);
    await vi.waitFor(() => expect(armed.size).toBe(0));
  }, 30_000);
});
