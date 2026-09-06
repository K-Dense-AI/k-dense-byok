import fs from "node:fs";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  listComputeReservations,
  projectCostSummary,
  reserveComputeBudget,
  sessionCostSummary,
} from "../src/cost/ledger.ts";
import {
  DurableModalJobManager,
} from "../src/modal/manager.ts";
import {
  EVENT_TRIM_INTERVAL,
  MAX_EVENT_ROWS,
  ModalJobStore,
} from "../src/modal/store.ts";
import {
  MODAL_INSTANCES,
  gpuString,
  validateInstanceChain,
  worstCaseReservationUsd,
} from "../src/modal/catalog.ts";
import {
  ModalTransferError,
  normalizeTransferPath,
  planInputs,
} from "../src/modal/transfer.ts";
import type {
  ModalAdapter,
  ModalEnvironment,
  ModalRemoteFilesystem,
  ModalRemoteProcess,
  ModalRemoteSandbox,
} from "../src/modal/adapter.ts";
import type { ModalJob } from "../src/modal/types.ts";
import { readSteps } from "../src/provenance/store.ts";

type Behavior =
  | { kind: "success"; exitCode?: number; stdout?: string; stderr?: string }
  | { kind: "failure"; message: string }
  | { kind: "hang" };

class FakeFilesystem implements ModalRemoteFilesystem {
  files = new Map<string, Buffer>();

  async makeDirectory(): Promise<void> {}

  async copyFromLocal(localPath: string, remotePath: string): Promise<void> {
    this.files.set(remotePath, fs.readFileSync(localPath));
  }

  async copyToLocal(remotePath: string, localPath: string): Promise<void> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error(`missing remote file ${remotePath}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, value);
  }

  async listFiles(remotePath: string): Promise<any[]> {
    const prefix = `${remotePath.replace(/\/+$/, "")}/`;
    const found = new Map<string, "file" | "directory">();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split("/")[0];
      found.set(first, rest.includes("/") ? "directory" : "file");
    }
    return [...found.entries()].map(([name, type]) => {
      const filePath = `${prefix}${name}`;
      return {
        name,
        path: filePath,
        type,
        size: type === "file" ? this.files.get(filePath)?.length ?? 0 : 0,
        mode: 0,
        permissions: "",
        owner: "",
        group: "",
        modifiedTime: 0,
        symlinkTarget: null,
      };
    });
  }

  async stat(remotePath: string): Promise<any> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error("not found");
    return { path: remotePath, name: path.posix.basename(remotePath), type: "file", size: value.length };
  }

  async readText(remotePath: string): Promise<string> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error(`not found: ${remotePath}`);
    return value.toString("utf-8");
  }

  async writeText(data: string, remotePath: string): Promise<void> {
    this.files.set(remotePath, Buffer.from(data));
  }
}

class FakeSandbox implements ModalRemoteSandbox {
  readonly id: string;
  readonly filesystem = new FakeFilesystem();
  terminated = false;
  behavior: Behavior;
  private rejectWait?: (error: Error) => void;

  constructor(id: string, behavior: Behavior) {
    this.id = id;
    this.behavior = behavior;
  }

  async exec(command: string[]): Promise<ModalRemoteProcess> {
    if (command[0] === "mv") {
      const source = command[2];
      const destination = command[3];
      const value = this.filesystem.files.get(source);
      if (!value) throw new Error(`missing staged input ${source}`);
      this.filesystem.files.set(destination, value);
      this.filesystem.files.delete(source);
      return { wait: async () => 0 };
    }
    this.filesystem.files.set(
      "/workspace/.kady-job/status.json",
      Buffer.from(JSON.stringify({ state: "running", startedAt: Date.now() / 1000 })),
    );
    return {
      wait: () =>
        new Promise<number>((resolve, reject) => {
          this.rejectWait = reject;
          if (this.behavior.kind === "hang") return;
          setTimeout(() => {
            if (this.terminated) {
              reject(new Error("terminated"));
              return;
            }
            if (this.behavior.kind === "failure") {
              reject(new Error(this.behavior.message));
              return;
            }
            const exitCode = this.behavior.exitCode ?? 0;
            this.filesystem.files.set(
              "/workspace/.kady-job/stdout.log",
              Buffer.from(this.behavior.stdout ?? "ok\n"),
            );
            this.filesystem.files.set(
              "/workspace/.kady-job/stderr.log",
              Buffer.from(this.behavior.stderr ?? ""),
            );
            this.filesystem.files.set("/workspace/result.txt", Buffer.from("result\n"));
            this.filesystem.files.set(
              "/workspace/.kady-job/status.json",
              Buffer.from(JSON.stringify({ state: "finished", exitCode })),
            );
            resolve(0);
          }, 5);
        }),
    };
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    this.rejectWait?.(new Error("terminated"));
  }

  async poll(): Promise<number | null> {
    return this.terminated ? 1 : null;
  }

  detach(): void {}
}

class FakeModal {
  behaviors: Behavior[] = [];
  createErrors: Error[] = [];
  sandboxes = new Map<string, FakeSandbox>();
  prepared: Array<{ environment?: string; cache?: "project" | "none" }> = [];
  nextId = 1;

  factory = (): ModalAdapter => {
    const parent = this;
    return {
      async validate() {},
      async prepareEnvironment(
        _projectId,
        _image,
        _defaultImage,
        environment,
        cache,
      ): Promise<ModalEnvironment> {
        parent.prepared.push({ environment, cache });
        return {
          appId: "app",
          appName: "kady",
          cacheName: cache === "none" ? null : "cache",
          ...(environment
            ? { snapshotName: `published:${environment}`, imageId: "im-test" }
            : {}),
          opaque: {},
        };
      },
      async createSandbox() {
        const createError = parent.createErrors.shift();
        if (createError) throw createError;
        const sandbox = new FakeSandbox(
          `sb-${parent.nextId++}`,
          parent.behaviors.shift() ?? { kind: "success" },
        );
        parent.sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
      async fromId(id: string) {
        const sandbox = parent.sandboxes.get(id);
        if (!sandbox) throw new Error("sandbox not found");
        return sandbox;
      },
      async clearCache() {},
      close() {},
    };
  };
}

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  const paths = ensureProjectExists("default");
  fs.writeFileSync(path.join(paths.sandbox, "input.txt"), "input\n");
}

function persistedRunningJob(args: {
  id: string;
  sandboxId: string;
  sessionId: string;
  filesOut?: string[];
}): ModalJob {
  const now = Date.now();
  return {
    version: 1,
    id: args.id,
    projectId: "default",
    state: "running",
    request: {
      command: "work",
      instance: "cpu",
      gpuCount: 1,
      timeoutSec: 600,
      ...(args.filesOut ? { filesOut: args.filesOut } : {}),
    },
    owner: { sessionId: args.sessionId, submittedBy: "api" },
    createdAt: now - 100,
    updatedAt: now,
    queuedAt: now - 100,
    preparingAt: now - 90,
    runningAt: now - 80,
    cancelRequested: false,
    reservationUsd: 0.01,
    effectiveInstance: "cpu",
    effectiveGpu: null,
    pricePerHour: 0.05,
    sandboxId: args.sandboxId,
    sandboxName: `kady-${args.id}`,
    sandboxTags: { kady: "true", project: "default", job: args.id },
    sandboxCreatedAt: now - 75,
    inputFiles: [],
    outputFiles: [],
    missingOutputs: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutBaseCursor: 0,
    stderrBaseCursor: 0,
    eventSeq: 0,
    accounting: { reconciled: false },
  };
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

  it("recursively plans directories with checksums", () => {
    const root = resolvePaths("default").sandbox;
    fs.mkdirSync(path.join(root, "data", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "a.txt"), "a");
    fs.writeFileSync(path.join(root, "data", "nested", "b.txt"), "bb");
    const plan = planInputs(root, ["data"]);
    expect(plan.manifest.map((file) => file.path)).toEqual(["data/a.txt", "data/nested/b.txt"]);
    expect(plan.manifest.every((file) => file.sha256.length === 64)).toBe(true);
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
});
