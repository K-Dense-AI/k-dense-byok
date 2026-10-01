import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ensureProjectExists } from "../src/projects.ts";
import { createSession, disposeProjectSessions, getModelRuntime } from "../src/agent/session-registry.ts";
import { attachSessionObserver } from "../src/agent/session-observer.ts";
import { claimRun, isRunClaimed, waitForRunRelease } from "../src/agent/run-pipeline.ts";
import { deferSessionMessages } from "../src/agent/session-message-gate.ts";
import { sessionCostSummary } from "../src/cost/ledger.ts";
import { runBroker } from "../src/agent/run-broker.ts";
import { ProvenanceRecorder } from "../src/provenance/recorder.ts";

// Keep message ordering independent of host Python/R startup. The recorder's
// real queue/flush and the Pi message boundaries are still exercised below.
vi.mock("../src/provenance/environment.ts", async (original) => ({
  ...await original<Record<string, unknown>>(), captureEnvironment: async () => null,
}));

const projectId = "message-gate";
afterEach(async () => {
  await disposeProjectSessions(projectId);
  vi.restoreAllMocks();
});

it("replays real Pi message boundaries as observed, individually ledgered system runs", async () => {
  const paths = ensureProjectExists(projectId);
  const session = await createSession(projectId, paths);
  const model = session.model!;
  await getModelRuntime().setRuntimeApiKey(model.provider, "test-only");
  const provider = vi.fn(() => {
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "Completed" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  });
  session.agent.streamFunction = provider;
  const detach = attachSessionObserver({ projectId, paths, session });
  const claim = claimRun(projectId, session.sessionId)!;
  const resume = deferSessionMessages(session, projectId);
  const seen: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_start") return;
    const message = event.message;
    if (message.role === "custom") seen.push(message.customType);
    if (message.role === "user") seen.push("user");
  });
  try {
    const deliveries = [
      session.sendCustomMessage({ customType: "notice", content: "A saved notice", display: true }),
      session.sendCustomMessage({ customType: "completion", content: "Continue work", display: true }, { triggerTurn: true }),
      session.sendUserMessage("Another task"),
    ];
    await Promise.resolve();
    expect(provider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    claim.release();
    resume();
    await Promise.all(deliveries);
    expect(seen).toEqual(["notice", "completion", "user"]);
    expect(provider).toHaveBeenCalledTimes(2);
    const costs = sessionCostSummary(session.sessionId, projectId);
    expect(costs.entries).toHaveLength(2);
    expect(costs.totalUsd).toBeCloseTo(0.02, 6);
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
    expect(runBroker.get(projectId, session.sessionId)?.origin).toBe("system");
  } finally {
    claim.release();
    resume();
    unsubscribe();
    detach();
    await getModelRuntime().removeRuntimeApiKey(model.provider);
  }
}, 30_000);

it("preserves submission errors without dropping later queued notices", async () => {
  const paths = ensureProjectExists(projectId);
  const session = await createSession(projectId, paths);
  const original = session.sendCustomMessage.bind(session);
  vi.spyOn(session, "sendCustomMessage").mockRejectedValueOnce(new Error("Delivery failed")).mockImplementation(original);
  const claim = claimRun(projectId, session.sessionId)!;
  const resume = deferSessionMessages(session, projectId);
  const first = session.sendCustomMessage({ customType: "failed", content: "Failed notice", display: true });
  const second = session.sendCustomMessage({ customType: "saved", content: "Saved notice", display: true });
  const results = Promise.allSettled([first, second]);
  claim.release();
  resume();
  expect(await results).toEqual([
    { status: "rejected", reason: new Error("Delivery failed") },
    { status: "fulfilled", value: undefined },
  ]);
  expect(session.messages.some((message) => message.role === "custom" && message.customType === "saved")).toBe(true);
}, 30_000);

it("defers a settled-handler turn until the preceding run finishes provenance and accounting", async () => {
  const paths = ensureProjectExists(projectId);
  const session = await createSession(projectId, paths);
  const model = session.model!;
  await getModelRuntime().setRuntimeApiKey(model.provider, "test-only");
  const provider = vi.fn(() => {
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "Completed" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  });
  session.agent.streamFunction = provider;
  const detach = attachSessionObserver({ projectId, paths, session });
  let releaseFlush!: () => void;
  let flushStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFlush = resolve; });
  const started = new Promise<void>((resolve) => { flushStarted = resolve; });
  const flush = ProvenanceRecorder.prototype.flush;
  vi.spyOn(ProvenanceRecorder.prototype, "flush").mockImplementationOnce(async function () {
    flushStarted();
    await gate;
    await flush.call(this);
  });
  let next: Promise<void> | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_settled" && !next) {
      next = session.sendCustomMessage({ customType: "follow-up", content: "Continue again", display: true }, { triggerTurn: true });
    }
  });
  const first = session.sendCustomMessage({ customType: "initial", content: "Begin", display: true }, { triggerTurn: true });
  try {
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(isRunClaimed(projectId, session.sessionId)).toBe(true);
    releaseFlush();
    await first;
    await next;
    await waitForRunRelease(projectId, session.sessionId);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sessionCostSummary(session.sessionId, projectId).entries).toHaveLength(2);
    expect(sessionCostSummary(session.sessionId, projectId).totalUsd).toBeCloseTo(0.02, 6);
  } finally {
    releaseFlush();
    await first;
    await next;
    await waitForRunRelease(projectId, session.sessionId);
    unsubscribe();
    detach();
    await getModelRuntime().removeRuntimeApiKey(model.provider);
  }
}, 30_000);

it.each([false, true])("rejects deferred work when the observer is detached (manual gate=%s)", async (manualGate) => {
  const paths = ensureProjectExists(projectId);
  const session = await createSession(projectId, paths);
  const detach = attachSessionObserver({ projectId, paths, session });
  const claim = claimRun(projectId, session.sessionId)!;
  const resume = manualGate ? deferSessionMessages(session, projectId) : () => {};
  const pending = session.sendCustomMessage({ customType: "must-not-run", content: "Continue", display: true }, { triggerTurn: true });
  const rejected = expect(pending).rejects.toThrow("Session closed before the queued message was delivered");
  detach();
  claim.release();
  resume();
  await rejected;
  expect(session.messages.some((message) => message.role === "custom" && message.customType === "must-not-run")).toBe(false);
}, 30_000);
