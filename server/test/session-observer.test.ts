/**
 * The session observer adopts turns a Pi extension starts on an idle session
 * as system-initiated Kady runs: claimed, streamed through the broker,
 * ledgered, released. Driven with a fake session so no model is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({
    checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })),
  })),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
}));

import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { runBroker, type SequencedClientFrame } from "../src/agent/run-broker.ts";
import { claimRun, isRunClaimed } from "../src/agent/run-pipeline.ts";
import { currentRunId } from "../src/agent/run-ids.ts";
import { attachSessionObserver } from "../src/agent/session-observer.ts";

class FakeSession {
  sessionId = "obs-1";
  isStreaming = false;
  state: { errorMessage?: string } = {};
  model = { id: "fake-model", provider: "openrouter" } as never;
  messages: unknown[] = [];
  aborted = 0;
  private cost = 0;
  private listeners = new Set<(event: any) => void>();

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: any): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  spend(usd: number): void {
    this.cost += usd;
  }
  getSessionStats() {
    return { cost: this.cost, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  }
  getContextUsage() {
    return undefined;
  }
  async abort(): Promise<void> {
    this.aborted += 1;
    this.isStreaming = false;
  }
  /** A whole extension-initiated turn, as Pi would emit it. */
  turn(events: any[] = []): void {
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    for (const event of events) this.emit(event);
    this.emit({ type: "agent_end" });
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
  }
}

const log = { warn: vi.fn(), error: vi.fn() };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const frameTypes = (frames: SequencedClientFrame[]) => frames.map((f) => f.type);
const costRows = (projectId: string, sessionId: string) => {
  const file = path.join(resolvePaths(projectId).sandbox, ".kady", "runs", sessionId, "costs.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

let projectId: string;
let detach: (() => void) | null = null;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  runBroker.clear();
  projectId = createProject({ name: "Observed" }).id;
  log.warn.mockClear();
  log.error.mockClear();
});

afterEach(() => {
  detach?.();
  detach = null;
});

function attach(session: FakeSession, pid = projectId) {
  detach = attachSessionObserver({
    projectId: pid,
    paths: resolvePaths(pid),
    session: session as never,
    log,
  });
  return detach;
}

describe("session observer", () => {
  it("adopts an unclaimed agent_start as a streamed, ledgered system run", async () => {
    const session = new FakeSession();
    attach(session);

    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    const handle = runBroker.get(projectId, session.sessionId);
    expect(handle).toBeDefined();
    expect(handle!.state().run).toMatchObject({ origin: "system", kind: "turn" });
    expect(isRunClaimed(projectId, session.sessionId)).toBe(true);
    expect(currentRunId(projectId, session.sessionId)).toBe(handle!.runId);

    session.emit({
      type: "message_start",
      message: {
        role: "custom",
        customType: "subagent_supervisor_request",
        content: "Which threshold?",
        display: true,
        details: { agent: "worker", reason: "need_decision", interview: { nested: true } },
      },
    });
    session.spend(0.01);
    session.emit({ type: "turn_end", message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } } });
    session.emit({ type: "agent_end" });
    session.isStreaming = false;
    session.emit({ type: "agent_settled" });
    await flush();

    const state = handle!.state();
    expect(state.status).toBe("complete");
    expect(state.run?.reason).toBe("subagent_supervisor_request");
    const types = frameTypes(state.run!.frames);
    expect(types.filter((t) => t === "agent_start")).toHaveLength(1);
    expect(types[0]).toBe("run_start");
    expect(types).toContain("cost");
    expect(types[types.length - 1]).toBe("done");
    const custom = state.run!.frames.find((f) => f.type === "message_start" && f.role === "custom");
    expect(custom).toMatchObject({
      customType: "subagent_supervisor_request",
      content: "Which threshold?",
      details: { agent: "worker", reason: "need_decision" },
    });
    expect((custom as { details: Record<string, unknown> }).details).not.toHaveProperty("interview");

    const rows = costRows(projectId, session.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "agent", costUsd: 0.01 });
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
    expect(currentRunId(projectId, session.sessionId)).toBeUndefined();
  });

  it("stays passive while a route-owned claim exists", async () => {
    const session = new FakeSession();
    attach(session);
    const claim = claimRun(projectId, session.sessionId)!;
    session.turn([{ type: "turn_end", message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }]);
    await flush();
    expect(runBroker.get(projectId, session.sessionId)).toBeUndefined();
    expect(costRows(projectId, session.sessionId)).toHaveLength(0);
    claim.release();
  });

  it("treats several agent_start/agent_end pairs before agent_settled as one run", async () => {
    const session = new FakeSession();
    attach(session);
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    session.emit({ type: "agent_end" });
    session.emit({ type: "agent_start" }); // post-compaction continuation
    session.spend(0.02);
    session.emit({ type: "agent_end" });
    session.isStreaming = false;
    session.emit({ type: "agent_settled" });
    await flush();
    const handles = runBroker.activityForProject(projectId);
    expect(handles).toHaveLength(1);
    expect(runBroker.get(projectId, session.sessionId)!.state().status).toBe("complete");
    expect(costRows(projectId, session.sessionId)).toHaveLength(1);
  });

  it("publishes an idle custom message as a completed notice run with no ledger row", async () => {
    const session = new FakeSession();
    attach(session);
    session.emit({
      type: "message_start",
      message: { role: "custom", customType: "subagent_watchdog_warning", content: "Stalemate", display: true },
    });
    session.emit({ type: "message_end", message: { role: "custom" } });
    const handle = runBroker.get(projectId, session.sessionId);
    expect(handle).toBeDefined();
    const state = handle!.state();
    expect(state.status).toBe("complete");
    expect(state.run).toMatchObject({ origin: "system", kind: "notice", reason: "subagent_watchdog_warning" });
    expect(frameTypes(state.run!.frames)).toEqual(["run_start", "message_start", "done"]);
    expect(costRows(projectId, session.sessionId)).toHaveLength(0);
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);

    // A hidden message publishes nothing.
    runBroker.clear();
    session.emit({
      type: "message_start",
      message: { role: "custom", customType: "subagent-compaction-resume", content: "x", display: false },
    });
    expect(runBroker.get(projectId, session.sessionId)).toBeUndefined();
  });

  it("aborts a system run over the project cap after the listener returned, and ledgers it", async () => {
    const capped = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "earlier",
      projectId: capped.id,
      model: "m",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    const session = new FakeSession();
    attach(session, capped.id);
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    // Not inside the listener: nothing awaited yet.
    expect(session.aborted).toBe(0);
    await flush();
    expect(session.aborted).toBe(1);
    const handle = runBroker.get(capped.id, session.sessionId)!;
    expect(handle.activityState).toBe("blocked");
    expect(handle.state().run!.frames.some((f) => f.type === "error" && f.kind === "budget")).toBe(true);
    // Pi finishes the aborted turn (a partial request was billed); the run
    // then completes and is ledgered.
    session.spend(0.001);
    session.emit({ type: "agent_end" });
    session.isStreaming = false;
    session.emit({ type: "agent_settled" });
    await flush();
    expect(handle.isComplete).toBe(true);
    expect(costRows(capped.id, session.sessionId)).toHaveLength(1);
  });

  it("completes the handle and releases the claim when detached mid-run", async () => {
    const session = new FakeSession();
    const stop = attach(session);
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    const handle = runBroker.get(projectId, session.sessionId)!;
    stop();
    detach = null;
    await flush();
    expect(handle.isComplete).toBe(true);
    const types = frameTypes(handle.state().run!.frames);
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("done");
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
  });

  it("adopts late when the claim is released while the session is still streaming", async () => {
    const session = new FakeSession();
    attach(session);
    const claim = claimRun(projectId, session.sessionId)!;
    session.isStreaming = true;
    session.emit({ type: "agent_start" }); // route-owned: passive
    claim.release();
    session.emit({ type: "turn_start" }); // unclaimed + streaming → adopt
    expect(runBroker.get(projectId, session.sessionId)?.state().run).toMatchObject({ origin: "system" });
    session.emit({ type: "agent_end" });
    session.isStreaming = false;
    session.emit({ type: "agent_settled" });
    await flush();
    expect(runBroker.get(projectId, session.sessionId)!.isComplete).toBe(true);
  });
});
