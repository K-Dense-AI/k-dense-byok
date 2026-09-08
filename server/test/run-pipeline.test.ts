/**
 * The shared run pipeline: claim → open → execute. Ordering guarantees the
 * route relied on (claim before first await, run_start before model setup,
 * ledger before untrack) are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pinSession = vi.fn();
const unpinSession = vi.fn();
vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({
    checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })),
  })),
  pinSession: (...args: unknown[]) => pinSession(...args),
  unpinSession: (...args: unknown[]) => unpinSession(...args),
}));

import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { runBroker } from "../src/agent/run-broker.ts";
import { currentRunId } from "../src/agent/run-ids.ts";
import { claimRun, executeRun, isRunClaimed, openRun } from "../src/agent/run-pipeline.ts";
import type { BillingContext } from "../src/cost/billing.ts";

class FakeSession {
  sessionId = "pipe-1";
  isStreaming = false;
  state: { errorMessage?: string } = {};
  model = { id: "fake-model", provider: "openrouter" } as never;
  messages: unknown[] = [];
  cost = 0;
  private listeners = new Set<(event: any) => void>();
  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: any): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  getSessionStats() {
    return { cost: this.cost, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  }
  getContextUsage() {
    return undefined;
  }
}

const payg: BillingContext = { provider: "openrouter", authType: "api_key", billingMode: "payg" };
const log = { warn: vi.fn(), error: vi.fn() };
const baseline = { messages: [], contextUsage: null };
const costRows = (projectId: string, sessionId: string) => {
  const file = path.join(resolvePaths(projectId).sandbox, ".kady", "runs", sessionId, "costs.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean) : [];
};

let projectId: string;
beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  runBroker.clear();
  pinSession.mockClear();
  unpinSession.mockClear();
  projectId = createProject({ name: "Pipeline" }).id;
});

describe("claimRun", () => {
  it("is exclusive per session and releases idempotently", () => {
    const claim = claimRun(projectId, "s")!;
    expect(claim).not.toBeNull();
    expect(pinSession).toHaveBeenCalledWith(projectId, "s");
    expect(claimRun(projectId, "s")).toBeNull();
    expect(isRunClaimed(projectId, "s")).toBe(true);
    claim.release();
    claim.release();
    expect(unpinSession).toHaveBeenCalledTimes(1);
    expect(isRunClaimed(projectId, "s")).toBe(false);
    expect(claimRun(projectId, "s")).not.toBeNull();
  });
});

describe("openRun", () => {
  it("publishes run_start with origin and kind and stamps the run id", () => {
    const session = new FakeSession();
    const claim = claimRun(projectId, session.sessionId)!;
    const opened = openRun(claim, {
      origin: "system",
      kind: "turn",
      reason: "subagent_supervisor_request",
      prompt: "",
      images: [],
      baseline,
      session,
    });
    expect(currentRunId(projectId, session.sessionId)).toBe(opened.runId);
    const state = opened.handle.state();
    expect(state.run).toMatchObject({ origin: "system", kind: "turn", reason: "subagent_supervisor_request" });
    expect(state.run!.frames[0]).toMatchObject({
      type: "run_start",
      runId: opened.runId,
      origin: "system",
      kind: "turn",
      reason: "subagent_supervisor_request",
    });
    opened.abandon();
    expect(opened.handle.isComplete).toBe(true);
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
    expect(currentRunId(projectId, session.sessionId)).toBeUndefined();
  });

  it("releases the claim when the broker refuses the run", () => {
    const session = new FakeSession();
    // Another live handle for the same session makes broker.start throw.
    runBroker.start(projectId, session.sessionId, { runId: "other", prompt: "", images: [], baseline });
    const claim = claimRun(projectId, session.sessionId)!;
    expect(() =>
      openRun(claim, { origin: "user", kind: "turn", prompt: "x", images: [], baseline, session }),
    ).toThrow();
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
    expect(currentRunId(projectId, session.sessionId)).toBeUndefined();
  });

  it("abandon() runs onCleanup once and publishes the error", () => {
    const session = new FakeSession();
    const onCleanup = vi.fn();
    const claim = claimRun(projectId, session.sessionId)!;
    const opened = openRun(claim, {
      origin: "user",
      kind: "turn",
      prompt: "x",
      images: [],
      baseline,
      session,
      onCleanup,
    });
    opened.abandon(new Error("model could not be prepared"));
    opened.abandon();
    expect(onCleanup).toHaveBeenCalledTimes(1);
    const types = opened.handle.state().run!.frames.map((f) => f.type);
    expect(types).toEqual(["run_start", "error", "done"]);
  });
});

describe("executeRun", () => {
  it("subscribes the pump before awaiting billing and ledgers on completion", async () => {
    const session = new FakeSession();
    const claim = claimRun(projectId, session.sessionId)!;
    const opened = openRun(claim, { origin: "user", kind: "turn", prompt: "x", images: [], baseline, session });
    let finish!: () => void;
    const running = executeRun(opened, {
      session,
      paths: resolvePaths(projectId),
      billing: new Promise<BillingContext>((resolve) => setTimeout(() => resolve(payg), 5)),
      budgetPolicy: "refuse",
      log,
      run: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    // Emitted synchronously after executeRun() returned its promise: the
    // pump must already be listening even though billing is unresolved.
    session.emit({ type: "text_delta_probe" });
    session.emit({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 10));
    session.cost = 0.03;
    finish();
    await running;
    const frames = opened.handle.state().run!.frames.map((f) => f.type);
    expect(frames).toContain("agent_start");
    expect(frames).toContain("cost");
    expect(frames[frames.length - 1]).toBe("done");
    expect(costRows(projectId, session.sessionId)).toHaveLength(1);
    expect(JSON.parse(costRows(projectId, session.sessionId)[0])).toMatchObject({ costUsd: 0.03 });
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
    expect(opened.handle.isComplete).toBe(true);
  });

  it("refuses over budget without running or ledgering; abort policy runs and ledgers", async () => {
    const capped = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "earlier",
      projectId: capped.id,
      model: "m",
      before: zero,
      after: { costUsd: 0.02, input: 1, output: 1, cacheRead: 0, total: 2 },
    });

    const refused = new FakeSession();
    const run = vi.fn(async () => {});
    let opened = openRun(claimRun(capped.id, refused.sessionId)!, {
      origin: "user", kind: "turn", prompt: "x", images: [], baseline, session: refused,
    });
    await executeRun(opened, { session: refused, paths: resolvePaths(capped.id), billing: payg, budgetPolicy: "refuse", log, run });
    expect(run).not.toHaveBeenCalled();
    let types = opened.handle.state().run!.frames.map((f) => f.type);
    expect(types).toEqual(["run_start", "error", "done"]);
    expect(opened.handle.activityState).toBe("blocked");
    expect(costRows(capped.id, refused.sessionId)).toHaveLength(0);

    const aborted = new FakeSession();
    aborted.sessionId = "pipe-2";
    const onBudgetAbort = vi.fn();
    const runAborted = vi.fn(async () => {
      aborted.cost = 0.001;
    });
    opened = openRun(claimRun(capped.id, aborted.sessionId)!, {
      origin: "system", kind: "turn", prompt: "", images: [], baseline, session: aborted,
    });
    await executeRun(opened, { session: aborted, paths: resolvePaths(capped.id), billing: payg, budgetPolicy: "abort", onBudgetAbort, log, run: runAborted });
    expect(onBudgetAbort).toHaveBeenCalledTimes(1);
    expect(runAborted).toHaveBeenCalledTimes(1);
    types = opened.handle.state().run!.frames.map((f) => f.type);
    expect(types).toContain("cost");
    expect(costRows(capped.id, aborted.sessionId)).toHaveLength(1);
  });

  it("never runs after an explicit abort request and still completes the handle", async () => {
    const session = new FakeSession();
    const opened = openRun(claimRun(projectId, session.sessionId)!, {
      origin: "user", kind: "turn", prompt: "x", images: [], baseline, session,
    });
    opened.handle.requestAbort();
    const run = vi.fn(async () => {});
    await executeRun(opened, { session, paths: resolvePaths(projectId), billing: payg, budgetPolicy: "refuse", log, run });
    expect(run).not.toHaveBeenCalled();
    expect(opened.handle.isComplete).toBe(true);
    expect(isRunClaimed(projectId, session.sessionId)).toBe(false);
  });

  it("surfaces a thrown run as an error frame and still cleans up", async () => {
    const session = new FakeSession();
    const onCleanup = vi.fn();
    const opened = openRun(claimRun(projectId, session.sessionId)!, {
      origin: "user", kind: "turn", prompt: "x", images: [], baseline, session, onCleanup,
    });
    await executeRun(opened, {
      session, paths: resolvePaths(projectId), billing: payg, budgetPolicy: "refuse", log,
      run: async () => { throw new Error("provider exploded"); },
    });
    const frames = opened.handle.state().run!.frames;
    expect(frames.some((f) => f.type === "error" && f.message === "provider exploded")).toBe(true);
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(opened.handle.isComplete).toBe(true);
    // abandon() after handoff is a no-op.
    opened.abandon(new Error("late"));
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });
});
