import fs from "node:fs";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  listComputeReservations,
  projectCostSummary,
  reattributeModalJobCost,
  recordModalJobCost,
  reserveComputeBudget,
  sessionCostSummary,
} from "../src/cost/ledger.ts";
import {
  DurableModalJobManager,
  modalJobManager,
} from "../src/modal/manager.ts";
import { makeModalTools } from "../src/agent/modal-tool.ts";
import { ModalJobError } from "../src/modal/types.ts";
import {
  EVENT_TRIM_INTERVAL,
  MAX_EVENT_ROWS,
  ModalJobStore,
} from "../src/modal/store.ts";
import {
  MODAL_INSTANCES,
  gpuString,
  sandboxLifetimeSec,
  transferHeadroomSec,
  validateInstanceChain,
  worstCaseReservationUsd,
} from "../src/modal/catalog.ts";
import {
  ModalTransferError,
  hashInputPlan,
  normalizeTransferPath,
  planInputs,
} from "../src/modal/transfer.ts";
import { type Behavior, FakeModal, FakeSandbox, persistedRunningJob } from "./helpers/fake-modal.ts";
import { readSteps } from "../src/provenance/store.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  const paths = ensureProjectExists("default");
  fs.writeFileSync(path.join(paths.sandbox, "input.txt"), "input\n");
}

beforeEach(reset);
afterEach(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("Modal catalogue and transfer safety", () => {
  it("preserves legacy ids, expands through B200, and validates counts/fallbacks", () => {
    const ids = MODAL_INSTANCES.map((instance) => instance.id);
    expect(ids).toEqual(expect.arrayContaining(["cpu", "t4", "a10g", "h100", "h200", "b200"]));
    const h100 = MODAL_INSTANCES.find((instance) => instance.id === "h100")!;
    expect(gpuString(h100, 4)).toBe("H100:4");
    expect(() => validateInstanceChain({ command: "x", instance: "a10g", gpuCount: 5 })).toThrow(
      /at most 4/,
    );
    expect(
      validateInstanceChain({
        command: "x",
        instance: "h100",
        gpuCount: 2,
        gpuFallback: ["h200", "b200"],
      }).map((instance) => instance.id),
    ).toEqual(["h100", "h200", "b200"]);
  });

  it("rejects traversal/missing inputs and symlinks escaping the sandbox", () => {
    const root = resolvePaths("default").sandbox;
    expect(() => normalizeTransferPath("../secret")).toThrow(ModalTransferError);
    expect(() => planInputs(root, ["missing.txt"])).toThrow(/does not exist/);
    const external = path.join(PROJECTS_ROOT, "outside.txt");
    fs.writeFileSync(external, "secret");
    fs.symlinkSync(external, path.join(root, "escape.txt"));
    expect(() => planInputs(root, ["escape.txt"])).toThrow(/symlink outside/i);
  });

  it("plans directories without reading bytes, then hashes them by streaming", async () => {
    const root = resolvePaths("default").sandbox;
    fs.mkdirSync(path.join(root, "data", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "a.txt"), "a");
    fs.writeFileSync(path.join(root, "data", "nested", "b.txt"), "bb");
    const plan = planInputs(root, ["data"]);
    expect(plan.manifest.map((file) => file.path)).toEqual(["data/a.txt", "data/nested/b.txt"]);
    expect(plan.manifest.every((file) => file.sha256 === undefined)).toBe(true);
    await hashInputPlan(plan);
    expect(plan.manifest.every((file) => file.sha256?.length === 64)).toBe(true);
    expect(plan.manifest[0].sha256).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });

  it("supports named reusable environments and opting out of the project cache", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      {
        command: "echo environment",
        environment: "science-stack",
        cache: "none",
      },
      { sessionId: "environment-session", submittedBy: "api" },
    );
    await manager.wait("default", job.id, 3000);
    expect(fake.prepared).toContainEqual({
      environment: "science-stack",
      cache: "none",
    });
    expect(
      fs.existsSync(
        path.join(resolvePaths("default").modalEnvironmentsDir, "science-stack.json"),
      ),
    ).toBe(true);
  });
});

describe("Modal reservations and store", () => {
  it("counts reservations as committed without changing spent totals", () => {
    reserveComputeBudget({
      projectId: "default",
      reservationId: "mj_reserved",
      sessionId: "s1",
      amountUsd: 0.25,
    });
    const summary = projectCostSummary("default");
    expect(summary.spentUsd).toBe(0);
    expect(summary.reservedUsd).toBe(0.25);
    expect(summary.committedUsd).toBe(0.25);
    expect(summary.budget.totalUsd).toBe(0.25);
  });

  it("strictly rejects a worst-case reservation beyond the project cap", () => {
    createProject({ name: "Capped", projectId: "capped", spendLimitUsd: 0.01 });
    expect(
      worstCaseReservationUsd({ command: "x", instance: "cpu", timeoutSec: 1000 }),
    ).toBeGreaterThan(0.01);
    expect(() =>
      reserveComputeBudget({
        projectId: "capped",
        reservationId: "mj_too_big",
        sessionId: "s",
        amountUsd: 0.02,
      }),
    ).toThrow(/exceed/);
  });

  it("recovery releases an orphan reservation created before any job record", async () => {
    reserveComputeBudget({
      projectId: "default",
      reservationId: "mj_orphaned",
      sessionId: "s",
      amountUsd: 1,
    });
    const manager = new DurableModalJobManager(new FakeModal().factory);
    await manager.recoverProject("default");
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("atomically stores job metadata, events, and byte-cursor bounded logs", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory, new ModalJobStore());
    const job = manager.submit(
      "default",
      { command: "echo ok", filesIn: ["input.txt"], filesOut: ["result.txt"] },
      { sessionId: "store-session", submittedBy: "api" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(fs.existsSync(path.join(resolvePaths("default").modalJobsDir, job.id, "job.json"))).toBe(true);
    expect(manager.store.events("default", job.id).map((event) => event.state)).toContain("running");
    const log = manager.store.readLog("default", job.id, "stdout", 0, 100);
    expect(log.data).toContain("ok");
    expect(log.nextCursor).toBeGreaterThan(0);
    manager.store.appendLog("default", job.id, "stdout", Buffer.alloc(8 * 1024 * 1024 + 64, 120));
    const rolled = manager.store.readLog("default", job.id, "stdout", 0, 128);
    expect(rolled.reset).toBe(true);
    expect(rolled.baseCursor).toBeGreaterThan(0);
    expect(Buffer.byteLength(rolled.data)).toBe(128);
    expect(fs.readFileSync(path.join(resolvePaths("default").sandbox, "result.txt"), "utf-8")).toBe(
      "result\n",
    );
  });

  it("records a terminal job as a compute provenance step in the owner session", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory, new ModalJobStore());
    const job = manager.submit(
      "default",
      { command: "echo ok", filesIn: ["input.txt"], filesOut: ["result.txt"] },
      { sessionId: "prov-session", runId: "run_prov", submittedBy: "lead" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");

    const steps = readSteps("prov-session", "default");
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step).toMatchObject({
      id: `modal:${job.id}`,
      role: "compute",
      toolName: "modal_job",
      runId: "run_prov",
    });
    expect(step.inputs.map((ref) => ref.path)).toEqual(["input.txt"]);
    expect(step.outputs).toHaveLength(1);
    expect(step.outputs[0]).toMatchObject({
      path: "result.txt",
      change: "wrote",
      confidence: "observed",
    });
    // The hash is the one collectOutputs took as it installed the file.
    expect(step.outputs[0].sha256).toBe(terminal.outputFiles[0].sha256);
    expect(step.compute).toMatchObject({ provider: "modal", jobId: job.id, exitCode: 0 });
  });

  it("bounds the event log and keeps the newest rows", () => {
    const store = new ModalJobStore();
    // A job that retries or falls back repeatedly would otherwise grow
    // events.jsonl without bound. Resume an over-long history and stop one
    // event short of a trim tick, so a single append triggers the trim.
    const trimAt = MAX_EVENT_ROWS + EVENT_TRIM_INTERVAL;
    store.create({
      ...persistedRunningJob({ id: "mj_events", sandboxId: "sb-1", sessionId: "s1" }),
      eventSeq: trimAt - 2,
    });
    const file = path.join(resolvePaths("default").modalJobsDir, "mj_events", "events.jsonl");
    const history = Array.from({ length: MAX_EVENT_ROWS + 50 }, (_, i) =>
      JSON.stringify({ seq: i + 1, ts: i, type: "log", message: `tick ${i}` }),
    );
    fs.appendFileSync(file, history.join("\n") + "\n");

    const last = store.appendEvent("default", "mj_events", {
      type: "log",
      message: "newest",
    });
    expect(last.seq % EVENT_TRIM_INTERVAL).toBe(0);
    const events = store.events("default", "mj_events");
    expect(events).toHaveLength(MAX_EVENT_ROWS);
    expect(events.at(-1)?.message).toBe("newest");
    // seq stays monotonic across trims so `after` cursors keep working.
    expect(store.events("default", "mj_events", events.at(-2)!.seq)).toHaveLength(1);
  });

  it("returns the readable events when one row is torn", () => {
    const store = new ModalJobStore();
    store.create(
      persistedRunningJob({ id: "mj_torn", sandboxId: "sb-2", sessionId: "s1" }),
    );
    store.appendEvent("default", "mj_torn", { type: "log", message: "before" });
    const file = path.join(resolvePaths("default").modalJobsDir, "mj_torn", "events.jsonl");
    fs.appendFileSync(file, '{"seq":99,"type":"log"\n');
    store.appendEvent("default", "mj_torn", { type: "log", message: "after" });
    expect(
      store.events("default", "mj_torn").map((event) => event.message),
    ).toEqual(["Job queued", "before", "after"]);
  });
});

describe("Durable Modal manager accounting", () => {
  it.each([
    ["succeeded", { kind: "success" } as Behavior, 0],
    ["failed", { kind: "success", exitCode: 7 } as Behavior, 7],
    ["failed", { kind: "failure", message: "remote exploded" } as Behavior, undefined],
    ["failed", { kind: "failure", message: "sandbox timed out" } as Behavior, undefined],
  ])("reconciles reservations and ledgers terminal state %s", async (state, behavior, exitCode) => {
    const fake = new FakeModal();
    fake.behaviors.push(behavior);
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      { command: "work", filesOut: ["result.txt"] },
      { sessionId: `session-${state}-${String(exitCode)}`, submittedBy: "api" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe(state);
    expect(terminal.accounting.reconciled).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
    const costs = sessionCostSummary(terminal.owner.sessionId, "default");
    expect(costs.entries).toHaveLength(1);
    expect(costs.entries[0]).toMatchObject({
      role: "compute",
      jobId: job.id,
      estimated: true,
      terminalState: state,
    });
  });

  it("falls back to the next validated instance and persists the effective choice", async () => {
    const fake = new FakeModal();
    fake.createErrors.push(new Error("H100 capacity unavailable"));
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      {
        command: "work",
        instance: "h100",
        gpuFallback: ["h200"],
        filesOut: ["result.txt"],
      },
      { sessionId: "fallback-session", submittedBy: "api" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(terminal.effectiveInstance).toBe("h200");
    expect(
      manager.store.events("default", job.id).some((event) => event.type === "instance_fallback"),
    ).toBe(true);
  });

  it("gives the sandbox transfer headroom beyond the command timeout and reserves for it", async () => {
    expect(transferHeadroomSec(60)).toBe(60);
    expect(transferHeadroomSec(1000)).toBe(100);
    expect(transferHeadroomSec(24 * 3600)).toBe(900);
    expect(sandboxLifetimeSec(1000)).toBe(1100);
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const request = { command: "work", instance: "cpu", timeoutSec: 1000 };
    const job = manager.submit("default", request, { sessionId: "s-headroom", submittedBy: "api" });
    expect(job.reservationUsd).toBeCloseTo(worstCaseReservationUsd(request), 12);
    expect(job.reservationUsd).toBeCloseTo(MODAL_INSTANCES.find((s) => s.id === "cpu")!.pricePerHour * (1100 / 3600), 12);
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    // Sandbox lifetime carries the headroom; the wrapped command does not.
    expect(fake.createParams.at(-1)?.timeoutMs).toBe(1100 * 1000);
    const sandbox = fake.sandboxes.get(terminal.sandboxId!)!;
    const wrapper = sandbox.execParams.find((call) => call.command[0] === "python3" && String(call.command[1]).endsWith("wrapper.py"));
    expect(wrapper?.params?.timeoutMs).toBe(1000 * 1000);
    // Settled spend can never exceed the lifetime-based hold.
    expect(terminal.accounting.estimatedCostUsd!).toBeLessThanOrEqual(job.reservationUsd + 1e-12);
  });

  it("does not try other instances when the credentials themselves are rejected", async () => {
    const fake = new FakeModal();
    fake.createErrors.push(new ModalJobError("AUTH_FAILED", "UNAUTHENTICATED: token revoked", 401, false));
    // A second error is queued so a wrongly-continued chain would consume it.
    fake.createErrors.push(new Error("H200 capacity unavailable"));
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      { command: "work", instance: "h100", gpuFallback: ["h200"] },
      { sessionId: "auth-session", submittedBy: "api" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.error).toMatchObject({ code: "AUTH_FAILED", retryable: false });
    expect(fake.createErrors).toHaveLength(1);
    expect(
      manager.store.events("default", job.id).some((event) => event.type === "instance_fallback"),
    ).toBe(false);
    expect(terminal.accounting.reconciled).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("closes the create/abort window and accounts cancellation after sandbox creation", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "hang" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      { command: "sleep forever" },
      { sessionId: "cancel-session", submittedBy: "lead" },
    );
    while (!manager.get("default", job.id).sandboxId) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await manager.cancel("default", job.id);
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("cancelled");
    expect(terminal.accounting.reconciled).toBe(true);
    expect(fake.sandboxes.get(terminal.sandboxId!)?.terminated).toBe(true);
    expect(sessionCostSummary("cancel-session", "default").entries[0].terminalState).toBe(
      "cancelled",
    );
  });

  it("marks an unattachable persisted sandbox lost and reconciles its estimate", async () => {
    const id = "mj_lost_recovery";
    reserveComputeBudget({
      projectId: "default",
      reservationId: id,
      sessionId: "recovery-session",
      amountUsd: 0.01,
    });
    const fake = new FakeModal();
    const store = new ModalJobStore();
    store.create(
      persistedRunningJob({
        id,
        sandboxId: "sb-gone",
        sessionId: "recovery-session",
      }),
    );
    const manager = new DurableModalJobManager(fake.factory, store);
    await manager.recoverProject("default");
    const terminal = await manager.wait("default", id, 3000);
    expect(terminal.state).toBe("lost");
    expect(terminal.accounting.reconciled).toBe(true);
    expect(sessionCostSummary("recovery-session", "default").entries[0]).toMatchObject({
      jobId: id,
      terminalState: "lost",
    });
  });

  it("reattaches a surviving sandbox, collects outputs, and succeeds", async () => {
    const id = "mj_live_recovery";
    reserveComputeBudget({
      projectId: "default",
      reservationId: id,
      sessionId: "live-recovery-session",
      amountUsd: 0.01,
    });
    const fake = new FakeModal();
    const sandbox = new FakeSandbox("sb-live", { kind: "success" });
    sandbox.filesystem.files.set(
      "/workspace/.kady-job/status.json",
      Buffer.from(JSON.stringify({ state: "finished", exitCode: 0 })),
    );
    sandbox.filesystem.files.set("/workspace/.kady-job/stdout.log", Buffer.from("recovered\n"));
    sandbox.filesystem.files.set("/workspace/.kady-job/stderr.log", Buffer.alloc(0));
    sandbox.filesystem.files.set("/workspace/result.txt", Buffer.from("recovered result\n"));
    fake.sandboxes.set(sandbox.id, sandbox);
    const store = new ModalJobStore();
    store.create(
      persistedRunningJob({
        id,
        sandboxId: sandbox.id,
        sessionId: "live-recovery-session",
        filesOut: ["result.txt"],
      }),
    );
    store.appendLog("default", id, "stdout", "recovered\n");
    const manager = new DurableModalJobManager(fake.factory, store);
    await manager.recoverProject("default");
    const terminal = await manager.wait("default", id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(fs.readFileSync(path.join(resolvePaths("default").sandbox, "result.txt"), "utf-8")).toBe(
      "recovered result\n",
    );
    expect(manager.result("default", id).stdout).toBe("recovered\n");
  });

  it("reattributes completed subagent jobs and compute cost to the parent session", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit(
      "default",
      { command: "echo child" },
      {
        sessionId: "subagent-child-run",
        subagentRunId: "child-run",
        submittedBy: "subagent",
      },
    );
    await manager.wait("default", job.id, 3000);
    expect(
      manager.reattributeSubagentJobs("default", "child-run", "parent-session"),
    ).toBe(1);
    expect(manager.get("default", job.id).owner.sessionId).toBe("parent-session");
    expect(sessionCostSummary("subagent-child-run", "default").entries).toEqual([]);
    expect(sessionCostSummary("parent-session", "default").entries[0]).toMatchObject({
      jobId: job.id,
      role: "compute",
    });
  });

  it("reattributes by the child's session file when no run id exists (pi-subagents ≥0.65)", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const sessionFile = path.resolve("/tmp/pi-sessions/child-a.jsonl");
    const job = manager.submit(
      "default",
      { command: "echo child" },
      {
        sessionId: "subagent-child-a",
        subagentSessionFile: sessionFile,
        submittedBy: "subagent",
      },
    );
    const other = manager.submit(
      "default",
      { command: "echo other" },
      {
        sessionId: "subagent-child-b",
        subagentSessionFile: path.resolve("/tmp/pi-sessions/child-b.jsonl"),
        submittedBy: "subagent",
      },
    );
    await manager.wait("default", job.id, 3000);
    await manager.wait("default", other.id, 3000);
    expect(manager.reattributeSubagentJobs("default", sessionFile, "parent-session")).toBe(1);
    expect(manager.get("default", job.id).owner.sessionId).toBe("parent-session");
    expect(manager.get("default", other.id).owner.sessionId).toBe("subagent-child-b");
    expect(sessionCostSummary("subagent-child-a", "default").entries).toEqual([]);
    expect(sessionCostSummary("parent-session", "default").entries[0]).toMatchObject({
      jobId: job.id,
      role: "compute",
    });
  });
});

describe("Durable Modal manager recovery cleanup", () => {
  it("terminates a sandbox created just before a crash instead of leaving it to bill until timeout", async () => {
    // Crash landed between Modal creating the sandbox and us persisting its id:
    // the record is `preparing` with no sandbox id, but a live sandbox tagged
    // with the job id exists remotely.
    const store = new ModalJobStore();
    const fake = new FakeModal();
    const record = persistedRunningJob({ id: "mj_orphan_create", sandboxId: "unused", sessionId: "s-orphan" });
    record.state = "preparing";
    record.runningAt = undefined;
    record.sandboxId = undefined;
    record.sandboxCreatedAt = undefined;
    record.effectiveInstance = undefined;
    record.pricePerHour = undefined;
    store.create(record);
    reserveComputeBudget({ projectId: "default", reservationId: record.id, sessionId: "s-orphan", amountUsd: 0.01 });
    const orphan = new FakeSandbox("sb-orphaned", { kind: "hang" });
    orphan.tags = { kady: "true", project: "default", job: record.id };
    fake.sandboxes.set(orphan.id, orphan);
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory, store);
    await manager.recoverProject("default");
    const terminal = await manager.wait("default", record.id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(orphan.terminated).toBe(true);
    expect(terminal.sandboxId).not.toBe(orphan.id);
    expect(fake.sandboxes.size).toBe(2);
    expect(store.events("default", record.id).some((event) => event.type === "orphan_terminated")).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("records a fallback sandbox whose termination failed and cleans it up on recovery", async () => {
    class EventFailingStore extends ModalJobStore {
      failNext = true;
      override appendEvent(projectId: string, jobId: string, event: any) {
        if (event.type === "sandbox_created" && this.failNext) {
          this.failNext = false;
          throw new Error("EIO while appending event");
        }
        return super.appendEvent(projectId, jobId, event);
      }
    }
    const fake = new FakeModal();
    // First sandbox: created, then the local event append fails, then its
    // termination fails twice (once in the fallback path, once in finally).
    fake.terminateFailures.push(2, 0);
    fake.behaviors.push({ kind: "success" }, { kind: "success" });
    const store = new EventFailingStore();
    const manager = new DurableModalJobManager(fake.factory, store);
    const job = manager.submit(
      "default",
      { command: "work", instance: "h100", gpuFallback: ["h200"] },
      { sessionId: "s-orphan-fallback", submittedBy: "api" },
    );
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(terminal.effectiveInstance).toBe("h200");
    const first = fake.sandboxes.get("sb-1")!;
    expect(first.terminated).toBe(false);
    expect(terminal.orphanedSandboxIds).toEqual(["sb-1"]);
    // Restart-style recovery retries the termination and clears the record.
    await manager.recoverProject("default");
    expect(first.terminated).toBe(true);
    expect(store.require("default", job.id).orphanedSandboxIds).toBeUndefined();
  });

  it("terminates the surviving sandbox of any terminal job on recovery, not only approved ones", async () => {
    const store = new ModalJobStore();
    const fake = new FakeModal();
    const sandbox = new FakeSandbox("sb-survivor", { kind: "hang" });
    fake.sandboxes.set(sandbox.id, sandbox);
    const record = persistedRunningJob({ id: "mj_terminal_live", sandboxId: sandbox.id, sessionId: "s-survivor" });
    record.state = "failed";
    record.finishedAt = Date.now();
    record.accounting = { reconciled: true, estimatedCostUsd: 0 };
    store.create(record);
    const manager = new DurableModalJobManager(fake.factory, store);
    await manager.recoverProject("default");
    expect(sandbox.terminated).toBe(true);
    expect(store.require("default", record.id).sandboxTerminatedAt).toBeTypeOf("number");
  });

  it("resyncs logical log counters with the retained bytes after a torn append", () => {
    const store = new ModalJobStore();
    const record = persistedRunningJob({ id: "mj_log_resync", sandboxId: "sb-x", sessionId: "s-log" });
    store.create(record);
    store.appendLog("default", record.id, "stdout", "hello world\n");
    // Simulate a crash after the bytes hit disk but before the counter write.
    store.update("default", record.id, (job) => {
      job.stdoutBytes = 3;
    });
    store.resyncLogCounters("default", record.id);
    const job = store.require("default", record.id);
    expect(job.stdoutBytes).toBe("hello world\n".length);
    expect(store.readLog("default", record.id, "stdout", 0).data).toBe("hello world\n");
  });
});

describe("Durable Modal transfer hardening", () => {
  const root = () => resolvePaths("default").sandbox;

  it("never installs application state from the sandbox, even when a glob matches it", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesOut: ["**"] }, { sessionId: "s-reserved", submittedBy: "api" });
    // The remote command wrote into reserved roots before the success hook ran.
    const sandboxReady = async () => {
      const deadline = Date.now() + 3000;
      while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      return [...fake.sandboxes.values()][0]!;
    };
    const sandbox = await sandboxReady();
    sandbox.filesystem.files.set("/workspace/.pi/mcp.json", Buffer.from('{"mcpServers":{"evil":{"command":"x"}}}'));
    sandbox.filesystem.files.set("/workspace/.kady/modal/jobs/x/job.json", Buffer.from("{}"));
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    expect(terminal.outputFiles.map((f) => f.path)).toEqual(["result.txt"]);
    expect(fs.existsSync(path.join(root(), ".pi", "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(root(), ".kady", "modal", "jobs", "x", "job.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root(), "result.txt"), "utf-8")).toBe("result\n");
  });

  it("collects a literal output without walking unrelated remote trees", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesOut: ["result.txt", "out/*.csv"] }, { sessionId: "s-scoped", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const sandbox = [...fake.sandboxes.values()][0]!;
    // A venv with more entries than the discovery budget, plus the wanted files.
    for (let i = 0; i < 25_000; i++) sandbox.filesystem.files.set(`/workspace/venv/lib/f${i}.py`, Buffer.from("x"));
    sandbox.filesystem.files.set("/workspace/out/a.csv", Buffer.from("1,2\n"));
    sandbox.filesystem.files.set("/workspace/out/b.txt", Buffer.from("no"));
    const terminal = await manager.wait("default", job.id, 5000);
    expect(terminal.state).toBe("succeeded");
    expect(terminal.outputFiles.map((f) => f.path)).toEqual(["out/a.csv", "result.txt"]);
    expect(terminal.missingOutputs).toEqual([]);
    expect(terminal.outputFiles.every((f) => f.sha256?.length === 64)).toBe(true);
  }, 15_000);

  it("rejects a download whose bytes differ from the sandbox's own checksum", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesOut: ["result.txt"] }, { sessionId: "s-flip", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    [...fake.sandboxes.values()][0]!.filesystem.tamperDownloads = "flip";
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.error?.code).toBe("CHECKSUM_MISMATCH");
    expect(fs.existsSync(path.join(root(), "result.txt"))).toBe(false);
  });

  it("reports a truncated download as such", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesOut: ["result.txt"] }, { sessionId: "s-trunc", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    [...fake.sandboxes.values()][0]!.filesystem.tamperDownloads = "truncate";
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.error?.code).toBe("TRANSFER_TRUNCATED");
  });

  it("verifies uploaded inputs remotely for ordinary jobs, not only approved ones", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesIn: ["input.txt"] }, { sessionId: "s-upload", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    [...fake.sandboxes.values()][0]!.filesystem.tamperUploads = true;
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.error?.code).toBe("INPUT_CHANGED");
    expect(terminal.inputFiles[0]?.sha256).toHaveLength(64);
  });

  it("degrades to size checks with a visible event when the image has no python3", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesIn: ["input.txt"], filesOut: ["result.txt"] }, { sessionId: "s-nopython", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const sandbox = [...fake.sandboxes.values()][0]!;
    sandbox.pythonMissing = true;
    // The wrapper itself is python; let it through so the job can finish.
    const originalExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command, params) => {
      if (command[0] === "python3" && String(command[1]).endsWith("wrapper.py")) {
        sandbox.pythonMissing = false;
        try { return await originalExec(command, params); } finally { sandbox.pythonMissing = true; }
      }
      return originalExec(command, params);
    };
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("succeeded");
    const skipped = manager.store.events("default", job.id).filter((event) => event.type === "verify_skipped");
    expect(skipped.map((event) => event.state)).toEqual(["preparing", "collecting"]);
    expect(fs.existsSync(path.join(root(), "result.txt"))).toBe(true);
  });

  it("installs nothing when an output's target is an existing directory, and leaves no temp files", async () => {
    fs.mkdirSync(path.join(root(), "result.txt"), { recursive: true }); // a directory named like the output
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "success" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesOut: ["result.txt", "other.txt"] }, { sessionId: "s-isdir", submittedBy: "api" });
    const deadline = Date.now() + 3000;
    while (fake.sandboxes.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    [...fake.sandboxes.values()][0]!.filesystem.files.set("/workspace/other.txt", Buffer.from("other\n"));
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.error?.code).toBe("OUTPUT_TARGET_IS_DIRECTORY");
    expect(fs.existsSync(path.join(root(), "other.txt"))).toBe(false);
    expect(fs.readdirSync(root()).filter((name) => name.includes(".modal-"))).toEqual([]);
  });

  it("records no input digest for a job that never ran", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "hang" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work", filesIn: ["input.txt"] }, { sessionId: "s-neverran", submittedBy: "api" });
    expect(job.inputFiles[0]?.sha256).toBeUndefined();
    await manager.cancel("default", job.id);
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("cancelled");
    const [step] = readSteps("s-neverran", "default");
    expect(step.inputs[0]).toMatchObject({ path: "input.txt", confidence: terminal.runningAt ? "observed" : "inferred" });
    if (!terminal.runningAt) expect(step.inputs[0].sha256).toBeUndefined();
  });
});

describe("Durable Modal log sync", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await sleep(25);
    }
  }
  function remoteLog(sandbox: FakeSandbox, content: string | Buffer, dropped: number, metaSize?: number) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    sandbox.filesystem.files.set("/workspace/.kady-job/stdout.log", bytes);
    sandbox.filesystem.files.set(
      "/workspace/.kady-job/stdout.log.meta",
      Buffer.from(JSON.stringify({ dropped, size: metaSize ?? bytes.length })),
    );
  }
  async function runningSandbox(manager: DurableModalJobManager, fake: FakeModal, sessionId: string) {
    fake.behaviors.push({ kind: "hang" });
    const job = manager.submit("default", { command: "work" }, { sessionId, submittedBy: "api" });
    await until(() => manager.store.require("default", job.id).state === "running");
    return { job, sandbox: [...fake.sandboxes.values()][0]! };
  }

  it("appends only unseen bytes across remote log rolls", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const { job, sandbox } = await runningSandbox(manager, fake, "s-logroll");
    // Logical stream "0123456789" through a 4-byte remote window.
    remoteLog(sandbox, "0123", 0);
    await sleep(800);
    remoteLog(sandbox, "4567", 4);
    await sleep(800);
    remoteLog(sandbox, "6789", 6);
    await sleep(800);
    await manager.cancel("default", job.id);
    await manager.wait("default", job.id, 3000);
    expect(manager.store.readLog("default", job.id, "stdout", 0).data).toBe("0123456789");
    expect(manager.store.events("default", job.id).some((event) => event.type === "log_gap")).toBe(false);
  }, 15_000);

  it("records a gap when bytes rolled out of the remote window before they were seen", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const { job, sandbox } = await runningSandbox(manager, fake, "s-loggap");
    remoteLog(sandbox, "6789", 6);
    await sleep(800);
    await manager.cancel("default", job.id);
    await manager.wait("default", job.id, 3000);
    expect(manager.store.readLog("default", job.id, "stdout", 0).data).toBe("6789");
    const gap = manager.store.events("default", job.id).find((event) => event.type === "log_gap");
    expect(gap?.data).toMatchObject({ stream: "stdout", bytes: 6 });
  }, 15_000);

  it("keeps multibyte characters intact when a tick lands mid-character", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const { job, sandbox } = await runningSandbox(manager, fake, "s-logutf8");
    const full = Buffer.from("héllo wörld\n", "utf-8");
    remoteLog(sandbox, full.subarray(0, 2), 0); // "h" plus the first byte of "é"
    await sleep(800);
    remoteLog(sandbox, full, 0);
    await sleep(800);
    await manager.cancel("default", job.id);
    await manager.wait("default", job.id, 3000);
    expect(manager.store.readLog("default", job.id, "stdout", 0).data).toBe("héllo wörld\n");
  }, 15_000);

  it("skips a tick whose sidecar disagrees with the file size instead of appending torn bytes", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const { job, sandbox } = await runningSandbox(manager, fake, "s-logmeta");
    remoteLog(sandbox, "0123", 0, 2); // wrapper mid-write: sidecar lags the file
    await sleep(800);
    expect(manager.store.readLog("default", job.id, "stdout", 0).data).toBe("");
    remoteLog(sandbox, "0123", 0);
    await sleep(800);
    await manager.cancel("default", job.id);
    await manager.wait("default", job.id, 3000);
    expect(manager.store.readLog("default", job.id, "stdout", 0).data).toBe("0123");
  }, 15_000);
});

describe("Durable Modal manager safety nets", () => {
  it("finalizes and reconciles a job whose worker crashed while finishing", async () => {
    // The first attempt to record the terminal state throws (disk full, a
    // Windows rename blocked by an indexer, ...). The worker chain must catch
    // it, finalize on the retry, reconcile the hold, and never surface an
    // unhandled rejection.
    class FlakyStore extends ModalJobStore {
      remainingFailures = 1;
      override transition(projectId: string, jobId: string, state: any, extra?: any) {
        if (state === "failed" && this.remainingFailures > 0) {
          this.remainingFailures--;
          throw new Error("ENOSPC: no space left on device");
        }
        return super.transition(projectId, jobId, state, extra);
      }
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "failure", message: "remote exploded" });
    const manager = new DurableModalJobManager(fake.factory, new FlakyStore());
    const job = manager.submit("default", { command: "work" }, { sessionId: "s-crash", submittedBy: "api" });
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("failed");
    expect(terminal.accounting.reconciled).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("[modal] worker crashed"))).toBe(false);
    errors.mockRestore();
  });

  it("keeps the process alive when finalization keeps failing, and recovery finishes the job later", async () => {
    class BrokenStore extends ModalJobStore {
      remainingFailures = 2;
      override transition(projectId: string, jobId: string, state: any, extra?: any) {
        if (state === "failed" && this.remainingFailures > 0) {
          this.remainingFailures--;
          throw new Error("ENOSPC: no space left on device");
        }
        return super.transition(projectId, jobId, state, extra);
      }
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "failure", message: "remote exploded" });
    const store = new BrokenStore();
    const manager = new DurableModalJobManager(fake.factory, store);
    const job = manager.submit("default", { command: "work" }, { sessionId: "s-broken", submittedBy: "api" });
    // Both finalization attempts fail; the worker chain must swallow that
    // (logged), leave the job non-terminal, and not reject unhandled.
    const stuck = await manager.wait("default", job.id, 1500);
    expect(["preparing", "running"]).toContain(stuck.state);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("[modal] failed to finalize job"))).toBe(true);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("[modal] worker crashed"))).toBe(false);
    // Restart-style recovery reattaches: the fake sandbox was already
    // terminated, so the job is marked lost and its hold reconciled.
    await manager.recoverProject("default");
    const terminal = await manager.wait("default", job.id, 3000);
    expect(terminal.state).toBe("lost");
    expect(terminal.accounting.reconciled).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
    errors.mockRestore();
  });

  it("cancelling a job with no live worker terminates its sandbox and reconciles the hold", async () => {
    // Recovery was deferred (no credentials at boot), so the running job has a
    // sandbox id but no worker. Cancel must still reach the remote sandbox.
    const store = new ModalJobStore();
    const fake = new FakeModal();
    const sandbox = new FakeSandbox("sb-orphan", { kind: "hang" });
    fake.sandboxes.set(sandbox.id, sandbox);
    store.create(persistedRunningJob({ id: "mj_deferred_cancel", sandboxId: sandbox.id, sessionId: "s-deferred" }));
    reserveComputeBudget({ projectId: "default", reservationId: "mj_deferred_cancel", sessionId: "s-deferred", amountUsd: 0.01 });
    const manager = new DurableModalJobManager(fake.factory, store);
    const cancelled = await manager.cancel("default", "mj_deferred_cancel");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.accounting.reconciled).toBe(true);
    expect(sandbox.terminated).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("cancelling while Modal is unconfigured still reconciles the hold", async () => {
    const store = new ModalJobStore();
    store.create(persistedRunningJob({ id: "mj_unconfigured", sandboxId: "sb-gone", sessionId: "s-unconf" }));
    reserveComputeBudget({ projectId: "default", reservationId: "mj_unconfigured", sessionId: "s-unconf", amountUsd: 0.01 });
    const manager = new DurableModalJobManager(() => {
      throw new ModalJobError("NOT_CONFIGURED", "Modal is not configured", 503);
    }, store);
    const cancelled = await manager.cancel("default", "mj_unconfigured");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.accounting.reconciled).toBe(true);
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("wait with a zero timeout returns the current state at once", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "hang" });
    const manager = new DurableModalJobManager(fake.factory);
    const job = manager.submit("default", { command: "work" }, { sessionId: "s-wait0", submittedBy: "api" });
    const started = Date.now();
    const current = await manager.wait("default", job.id, 0);
    expect(Date.now() - started).toBeLessThan(500);
    expect(["queued", "preparing", "running"]).toContain(current.state);
    await manager.cancel("default", job.id);
  });

  it("modal_wait with timeout_sec 0 returns immediately instead of blocking", async () => {
    const fake = new FakeModal();
    fake.behaviors.push({ kind: "hang" });
    modalJobManager.setAdapterFactoryForTests(fake.factory);
    const tools = makeModalTools("default", () => "s-tool-wait");
    const submit = tools.find((tool) => tool.name === "modal_submit")!;
    const wait = tools.find((tool) => tool.name === "modal_wait")!;
    const submitted = await submit.execute("call-1", { command: "work" } as any, undefined as any, undefined as any);
    const jobId = (submitted.details as { job_id: string }).job_id;
    const started = Date.now();
    const waited = await wait.execute("call-2", { job_id: jobId, timeout_sec: 0 } as any, undefined as any, undefined as any);
    expect(Date.now() - started).toBeLessThan(500);
    expect(["queued", "preparing", "running"]).toContain((waited.details as { state: string }).state);
    await modalJobManager.cancel("default", jobId);
    modalJobManager.setAdapterFactoryForTests(null);
  });

  it("re-attribution writes the parent ledger row before removing the child's", () => {
    recordModalJobCost({ projectId: "default", sessionId: "child", jobId: "mj_reattr", costUsd: 0.5, model: "modal:cpu", terminalState: "succeeded" });
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");
    expect(reattributeModalJobCost("default", "mj_reattr", "child", "parent")).toBe(true);
    const appendOrder = appendSpy.mock.invocationCallOrder[0];
    const renameOrder = renameSpy.mock.invocationCallOrder[0];
    appendSpy.mockRestore();
    renameSpy.mockRestore();
    expect(appendOrder).toBeLessThan(renameOrder);
    expect(sessionCostSummary("parent", "default").entries).toHaveLength(1);
    expect(sessionCostSummary("child", "default").entries).toHaveLength(0);
  });
});
