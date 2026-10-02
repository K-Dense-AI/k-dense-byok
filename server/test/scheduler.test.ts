/**
 * Server-owned scheduling: store readers, the resident session, the budget
 * hold, the automation routes, and the schedule gate in the subagent bridge.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const registry = {
  markSystemSession: vi.fn(),
  isSystemSession: vi.fn(() => false),
  created: [] as string[],
};
vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({ checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })) })),
  getModelRegistry: vi.fn(() => ({ find: () => null })),
  createSession: vi.fn(async () => {
    const id = `created-${registry.created.length + 1}`;
    registry.created.push(id);
    return { sessionId: id, agent: { state: { tools: [] } } };
  }),
  getSession: vi.fn(async (_p: string, _paths: unknown, id: string) => (id === "existing-host" ? { sessionId: id, agent: { state: { tools: [] } } } : null)),
  listSessions: vi.fn(async () => [{ id: "chat-1", created: new Date(), modified: new Date(), messageCount: 1 }, { id: "existing-host", created: new Date(), modified: new Date(), messageCount: 0 }]),
  disposeSession: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
  setSessionObserver: vi.fn(),
  markSystemSession: (...args: unknown[]) => registry.markSystemSession(...args),
  isSystemSession: () => false,
  abortProjectSessions: vi.fn(async () => {}),
  disposeProjectSessions: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { KADY_PI_AGENT_DIR, PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { recordRun, recordSubagentRun, scheduleSpend } from "../src/cost/ledger.ts";
import {
  configureScheduler,
  ensureSchedulerSession,
  listMissions,
  listSchedules,
  projectsWithActiveSchedules,
  reconcileBudgetHolds,
  schedulesDir,
} from "../src/agent/scheduler.ts";
import { readSchedulerState, writeSchedulerState } from "../src/agent/scheduler-state.ts";
import { makeSubagentLedgerExtension, setScheduleActivityListener } from "../src/agent/subagent-bridge.ts";

const app = await buildApp();
let projectId: string;
const hg = (pid: string) => ({ "x-project-id": pid });

function writeSchedule(pid: string, id: string, overrides: Record<string, unknown> = {}, runs: Record<string, unknown>[] = []) {
  const dir = path.join(schedulesDir(resolvePaths(pid)), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "schedule.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Schedule ${id}`,
      cwd: resolvePaths(pid).sandbox,
      trigger: { kind: "interval", every: "6h", everyMs: 21_600_000, anchorAt: "2026-09-08T00:00:00.000Z", nextRunAt: "2026-09-08T06:00:00.000Z" },
      target: { workflowScript: 'return runs.run("main", { agent: "data-validator", task: "Re-check" })' },
      overlap: "skip",
      catchUp: "latest",
      paused: false,
      ownerSessionFile: "/secret/should/not/leak",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
      ...overrides,
    }),
  );
  fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs }));
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "missions"), { recursive: true, force: true });
  projectId = createProject({ name: "Scheduled" }).id;
  registry.markSystemSession.mockClear();
  registry.created.length = 0;
  configureScheduler({ invoke: async () => ({ text: "ok", details: {} }), refresh: () => {}, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("schedule and mission readers", () => {
  it("reads pi-subagents' store with hold state and ledgered spend, never leaking owner paths", () => {
    writeSchedule(projectId, "nightly-qc", {}, [
      { schemaVersion: 1, id: "r2", scheduleId: "nightly-qc", plannedAt: "2026-09-08T06:00:00.000Z", dueReason: "timer", state: "completed", asyncId: "a2" },
      { schemaVersion: 1, id: "r1", scheduleId: "nightly-qc", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "manual", state: "failed_run", error: "boom" },
    ]);
    writeSchedule(projectId, "paused-one", { paused: true, trigger: { kind: "once", at: "2026-10-01T00:00:00.000Z" } });
    writeSchedulerState(resolvePaths(projectId), { heldByBudget: ["nightly-qc"] });
    recordSubagentRun(projectId, "host", "m", { cost: 0.25, tokens: { input: 1, output: 1, cacheRead: 0, total: 2 } }, undefined, { schedule: "nightly-qc", name: "Nightly" });
    recordSubagentRun(projectId, "host", "m", { cost: 0.5, tokens: { input: 1, output: 1, cacheRead: 0, total: 2 } });

    const schedules = listSchedules(projectId);
    expect(schedules.map((s) => s.id)).toEqual(["nightly-qc", "paused-one"]);
    const nightly = schedules[0];
    expect(nightly).toMatchObject({ heldByBudget: true, paused: false, spendUsd: 0.25, catchUp: "latest" });
    expect(nightly.lastRun).toMatchObject({ id: "r2", state: "completed" });
    expect(nightly.runs[1]).toMatchObject({ id: "r1", error: "boom" });
    expect(JSON.stringify(nightly)).not.toContain("/secret/");
    expect(schedules[1]).toMatchObject({ paused: true, trigger: { kind: "once" }, spendUsd: 0 });
    expect(scheduleSpend(projectId)).toEqual({ "nightly-qc": 0.25 });
    expect(projectsWithActiveSchedules()).toEqual([projectId]);
  });

  it("reads missions from the hashed project directory", () => {
    const sandbox = resolvePaths(projectId).sandbox;
    const dir = path.join(KADY_PI_AGENT_DIR, "missions", "projects", createHash("sha256").update(path.resolve(sandbox)).digest("hex"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "m1.json"), JSON.stringify({ schemaVersion: 1, id: "m1", title: "Ship QC", objective: "Validate uploads", status: "needs_decision", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T01:00:00.000Z", runs: [{ runId: "r", mode: "workflow", agent: "worker", status: "complete" }], workflowChildren: [], decisions: [{ id: "d1", status: "open", title: "Which threshold?" }], artifacts: [], receipts: [] }));
    fs.writeFileSync(path.join(dir, "m0.json"), JSON.stringify({ schemaVersion: 1, id: "m0", title: "Old", objective: "", status: "completed", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", runs: [], workflowChildren: [], decisions: [], artifacts: [], receipts: [] }));
    const missions = listMissions(projectId);
    expect(missions.map((m) => m.id)).toEqual(["m1", "m0"]);
    expect(missions[0]).toMatchObject({ status: "needs_decision", runs: [{ agent: "worker" }], decisions: [{ status: "open" }] });
  });
});

describe("resident session and budget hold", () => {
  it("creates a host once, records its id, marks it as a system session, and reuses it", async () => {
    const paths = resolvePaths(projectId);
    const first = await ensureSchedulerSession(projectId);
    expect(first?.sessionId).toBe("created-1");
    expect(readSchedulerState(paths).sessionId).toBe("created-1");
    expect(registry.markSystemSession).toHaveBeenCalledWith(projectId, "created-1");
    // A recorded id that still exists is reopened instead of created.
    writeSchedulerState(paths, { sessionId: "existing-host", heldByBudget: [] });
    const second = await ensureSchedulerSession(projectId);
    expect(second?.sessionId).toBe("existing-host");
    expect(registry.created).toEqual(["created-1"]);
  });

  it("pauses active schedules over the cap and resumes them when it clears", async () => {
    const paths = resolvePaths(projectId);
    const calls: Record<string, unknown>[] = [];
    configureScheduler({ invoke: async (_p, params) => { calls.push(params); return { text: "ok", details: {} }; }, log: { info() {}, warn() {}, error() {} } });
    writeSchedule(projectId, "a");
    writeSchedule(projectId, "b", { paused: true });
    const capped = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    // Use the capped project for the hold; copy the schedules there.
    fs.cpSync(schedulesDir(paths), schedulesDir(resolvePaths(capped.id)), { recursive: true });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({ sessionId: "s", projectId: capped.id, model: "m", before: zero, after: { ...zero, costUsd: 0.02 } });

    let result = await reconcileBudgetHolds(capped.id);
    expect(result).toEqual({ held: ["a"], released: [] });
    expect(calls).toEqual([{ action: "schedule.pause", id: "a" }]);
    expect(readSchedulerState(resolvePaths(capped.id)).heldByBudget).toEqual(["a"]);
    // Still over budget: nothing new.
    result = await reconcileBudgetHolds(capped.id);
    expect(result).toEqual({ held: [], released: [] });

    // Raise the cap → resume only what Kady paused.
    const { updateProject } = await import("../src/projects.ts");
    updateProject(capped.id, { spendLimitUsd: 100 });
    result = await reconcileBudgetHolds(capped.id);
    expect(result).toEqual({ held: [], released: ["a"] });
    expect(calls.at(-1)).toEqual({ action: "schedule.resume", id: "a" });
    expect(readSchedulerState(resolvePaths(capped.id)).heldByBudget).toEqual([]);
  });
});

describe("automation routes", () => {
  it("lists, acts on schedules through the resident session, and hides the host from the chat list", async () => {
    writeSchedule(projectId, "nightly-qc");
    writeSchedulerState(resolvePaths(projectId), { sessionId: "existing-host", heldByBudget: [] });
    const calls: Record<string, unknown>[] = [];
    configureScheduler({ invoke: async (_p, params) => { calls.push(params); return { text: "paused", details: {} }; } });

    let res = await app.inject({ method: "GET", url: "/schedules", headers: hg(projectId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ schedulerSessionId: "existing-host", heldByBudget: [], schedules: [{ id: "nightly-qc" }] });

    res = await app.inject({ method: "POST", url: "/schedules/nightly-qc/pause", headers: hg(projectId) });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ action: "schedule.pause", id: "nightly-qc" }]);
    res = await app.inject({ method: "POST", url: "/schedules/nightly-qc/explode", headers: hg(projectId) });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "POST", url: "/schedules/nope/run", headers: hg(projectId) });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: "GET", url: "/sessions", headers: hg(projectId) });
    expect((res.json() as { id: string }[]).map((s) => s.id)).toEqual(["chat-1"]);

    res = await app.inject({ method: "GET", url: "/missions", headers: hg(projectId) });
    expect(res.json()).toEqual({ missions: [] });
  });

  it("fires Run now quietly, refuses it (and a held resume) over the cap, and closes missions with the chosen status", async () => {
    writeSchedule(projectId, "nightly-qc");
    const calls: Record<string, unknown>[] = [];
    configureScheduler({ invoke: async (_p, params) => { calls.push(params); return { text: "Started.", details: {} }; } });
    let res = await app.inject({ method: "POST", url: "/schedules/nightly-qc/run", headers: hg(projectId) });
    expect(res.statusCode).toBe(200);
    // A noisy manual fire would wake the hidden resident session for a billed turn.
    expect(calls).toEqual([{ action: "schedule.run", id: "nightly-qc", quiet: true }]);

    const capped = createProject({ name: "Capped routes", spendLimitUsd: 0.01 }).id;
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({ sessionId: "s", projectId: capped, model: "m", before: zero, after: { ...zero, costUsd: 0.02 } });
    writeSchedule(capped, "held", { paused: true });
    writeSchedule(capped, "mine", { paused: true });
    writeSchedulerState(resolvePaths(capped), { heldByBudget: ["held"] });
    calls.length = 0;
    res = await app.inject({ method: "POST", url: "/schedules/held/run", headers: hg(capped) });
    expect(res.statusCode).toBe(402);
    expect(res.json().detail).toMatch(/spend limit/);
    res = await app.inject({ method: "POST", url: "/schedules/held/resume", headers: hg(capped) });
    expect(res.statusCode).toBe(402);
    // A schedule the user paused is theirs to resume; the tick holds it again if needed.
    res = await app.inject({ method: "POST", url: "/schedules/mine/resume", headers: hg(capped) });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ action: "schedule.resume", id: "mine" }]);

    const sandbox = resolvePaths(projectId).sandbox;
    const dir = path.join(KADY_PI_AGENT_DIR, "missions", "projects", createHash("sha256").update(path.resolve(sandbox)).digest("hex"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "m1.json"), JSON.stringify({ schemaVersion: 1, id: "m1", title: "QC", objective: "", status: "planned", createdAt: "", updatedAt: "", runs: [], decisions: [], receipts: [] }));
    calls.length = 0;
    res = await app.inject({ method: "POST", url: "/missions/m1/close", headers: hg(projectId), payload: {} });
    expect(res.statusCode).toBe(200);
    // pi-subagents reads missionStatus; a `status` key fell through to "completed".
    expect(calls).toEqual([{ action: "mission.close", missionId: "m1", missionStatus: "cancelled", summary: "Closed from the Automation panel." }]);
  });
});

describe("subagent bridge schedule handling", () => {
  type Handler = (event: unknown) => Promise<unknown>;
  function install(pid: string) {
    const handlers = new Map<string, Handler>();
    const events = new Map<string, (payload: unknown) => void>();
    makeSubagentLedgerExtension(pid, () => "host-session", () => ({ provider: "openrouter", id: "m" }) as never, () => false)({
      on: (name: string, h: Handler) => handlers.set(name, h),
      events: { on: (name: string, h: (p: unknown) => void) => events.set(name, h) },
    } as never);
    return { toolCall: handlers.get("tool_call")!, toolResult: handlers.get("tool_result")!, asyncComplete: events.get("subagent:async-complete")! };
  }

  it("gates schedule.create like a launch and notifies the scheduler; blocks runs over the cap", async () => {
    const seen: string[] = [];
    setScheduleActivityListener((pid, action) => seen.push(`${pid}:${action}`));
    try {
      const { toolCall, toolResult } = install(projectId);
      const script = 'return runs.run("main", { agent: "worker", task: "x" })';
      expect(await toolCall({ toolName: "subagent", input: { action: "schedule.create", id: "s", every: "6h", workflowScript: script } })).toBeUndefined();
      expect(seen).toEqual([]);
      await toolResult({ toolName: "subagent", input: { action: "schedule.create" }, isError: true, content: [] });
      expect(seen).toEqual([]);
      await toolResult({ toolName: "subagent", input: { action: "schedule.create" }, isError: false, content: [] });
      expect(seen).toEqual([`${projectId}:schedule.create`]);

      const capped = createProject({ name: "Capped2", spendLimitUsd: 0.01 });
      const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
      recordRun({ sessionId: "s", projectId: capped.id, model: "m", before: zero, after: { ...zero, costUsd: 0.02 } });
      const gated = install(capped.id);
      const created = (await gated.toolCall({ toolName: "subagent", input: { action: "schedule.create", id: "s", every: "6h", workflowScript: script } })) as { block?: boolean; reason?: string };
      expect(created).toMatchObject({ block: true });
      expect(created.reason).toMatch(/spend limit/);
      const ran = (await gated.toolCall({ toolName: "subagent", input: { action: "schedule.run", id: "s" } })) as { block?: boolean };
      expect(ran).toMatchObject({ block: true });
      // Unrelated management actions stay open.
      expect(await gated.toolCall({ toolName: "subagent", input: { action: "schedule.list" } })).toBeUndefined();
    } finally {
      setScheduleActivityListener(null);
    }
  });

  it("attributes an async completion from a schedule to origin.schedule in the ledger", async () => {
    const { asyncComplete } = install(projectId);
    const paths = resolvePaths(projectId);
    const child = path.join(paths.sandbox, "child.jsonl");
    fs.writeFileSync(
      child,
      [
        JSON.stringify({ type: "session", id: "c", version: 3 }),
        JSON.stringify({ type: "message", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-5.5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.03 } } } }),
      ].join("\n") + "\n",
    );
    asyncComplete({ id: "run-1", scheduleOrigin: { id: "nightly-qc", name: "Nightly QC" }, results: [{ agent: "data-validator", model: "openrouter/openai/gpt-5.5", sessionFile: child }] });
    const rows = fs.readFileSync(path.join(paths.sandbox, ".kady", "runs", "host-session", "costs.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "subagent", costUsd: 0.03, origin: { schedule: "nightly-qc", name: "Nightly QC" } });
    expect(scheduleSpend(projectId)).toEqual({ "nightly-qc": 0.03 });
  });

  it("keeps a fire's result text for the schedule history, matched by async run id", async () => {
    writeSchedule(projectId, "nightly-qc", { quiet: true, target: { workflowScript: "return 1", model: "openrouter/openai/gpt-6-astra" } }, [
      { schemaVersion: 1, id: "r2", scheduleId: "nightly-qc", plannedAt: "2026-09-08T06:00:00.000Z", dueReason: "timer", state: "completed", asyncId: "async-2" },
      { schemaVersion: 1, id: "r1", scheduleId: "nightly-qc", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "timer", state: "completed", asyncId: "async-1" },
    ]);
    const { asyncComplete } = install(projectId);
    asyncComplete({ runId: "async-2", id: "other", success: true, summary: "delegate:\n30 data rows (header excluded).", scheduleOrigin: { id: "nightly-qc" }, results: [] });
    // Not from a schedule: nothing to keep.
    asyncComplete({ runId: "async-9", success: true, summary: "chat work", results: [] });
    const [view] = listSchedules(projectId);
    expect(view).toMatchObject({ quiet: true, model: "openrouter/openai/gpt-6-astra" });
    expect(view.runs[0].summary).toBe("delegate:\n30 data rows (header excluded).");
    expect(view.runs[1].summary).toBeUndefined();
  });

  it("prefers a workflow child's own output over the serialized workflow return", async () => {
    writeSchedule(projectId, "nightly-qc", {}, [
      { schemaVersion: 1, id: "r1", scheduleId: "nightly-qc", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "manual", state: "completed", asyncId: "async-1" },
    ]);
    const sandbox = resolvePaths(projectId).sandbox;
    const output = path.join(sandbox, ".pi", "sessions", "subagent-artifacts", "child_output.md");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "user_data/dose_response.csv: 30 data rows.\n");
    const outside = path.join(PROJECTS_ROOT, "outside.md");
    fs.writeFileSync(outside, "not ours");
    const { asyncComplete } = install(projectId);
    asyncComplete({ runId: "async-1", success: true, summary: 'Workflow completed with 1 child run(s). Return: {"asyncDir": "/tmp/x", "output": "user_dat… (truncated', scheduleOrigin: { id: "nightly-qc" },
      results: [{ agent: "data-validator", artifactPaths: { outputPath: output } }, { agent: "other", artifactPaths: { outputPath: outside } }] });
    expect(listSchedules(projectId)[0].runs[0].summary).toBe("data-validator: user_data/dose_response.csv: 30 data rows.");
  });
});
