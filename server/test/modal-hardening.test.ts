import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { listComputeReservations, projectCostSummary, sessionCostSummary } from "../src/cost/ledger.ts";
import { writeGuardPolicy } from "../src/agent/guard-policy.ts";
import { hourlyEstimate, publicInstanceCatalog, resolveInstance, worstCaseReservationUsd } from "../src/modal/catalog.ts";
import { DurableModalJobManager } from "../src/modal/manager.ts";
import type { ModalAdapterFactory } from "../src/modal/adapter.ts";
import { ModalJobError } from "../src/modal/types.ts";
import { modalJobFiles, ModalJobStore } from "../src/modal/store.ts";
import { collectOutputs, planInputs } from "../src/modal/transfer.ts";
import { FakeModal, FakeSandbox, persistedRunningJob } from "./helpers/fake-modal.ts";

const root = () => resolvePaths("default").sandbox;
const checked = <T>(pending: Promise<T>) => pending;
const owner = { sessionId: "modal-hardening", submittedBy: "lead" as const };

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  ensureProjectExists("default");
});
afterEach(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("Modal cleanup and reservations", () => {
  it("charges an unconfirmed ordinary launch and discovers its sandbox without launching a fallback", async () => {
    const fake = new FakeModal();
    const factory: ModalAdapterFactory = () => {
      const adapter = fake.factory();
      return {
        ...adapter,
        async createSandbox(environment, params) {
          await adapter.createSandbox(environment, params);
          throw new ModalJobError("TIMEOUT", "Creation response was lost", 504, true);
        },
      };
    };
    const manager = new DurableModalJobManager(factory);
    const submitted = manager.submit("default", { command: "work", instance: "h100", gpuFallback: ["h200"] }, owner);
    const terminal = await manager.wait("default", submitted.id, 3000);
    expect(terminal).toMatchObject({
      state: "failed", error: { code: "LAUNCH_UNCERTAIN", retryable: false },
      sandboxId: "sb-1", sandboxCreatePending: false,
      accounting: { reconciled: true, conservative: true, estimatedCostUsd: submitted.reservationUsd },
    });
    expect(fake.createParams).toHaveLength(1);
    expect(fake.sandboxes.get("sb-1")?.terminated).toBe(true);
    expect(terminal.sandboxTerminatedAt).toBeTypeOf("number");
    expect(projectCostSummary("default").spentUsd).toBeCloseTo(submitted.reservationUsd);
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("recovers an unknown sandbox after lookup and termination failures without double charging", async () => {
    const fake = new FakeModal();
    fake.terminateFailures.push(1);
    let discoveryFails = true;
    const factory: ModalAdapterFactory = () => {
      const adapter = fake.factory();
      return {
        ...adapter,
        async createSandbox(environment, params) {
          await adapter.createSandbox(environment, params);
          throw new Error("connection reset after creation");
        },
        async findByTags(tags) {
          if (discoveryFails) throw new Error("discovery temporarily unavailable");
          return adapter.findByTags(tags);
        },
      };
    };
    const manager = new DurableModalJobManager(factory);
    const submitted = manager.submit("default", { command: "work" }, owner);
    const terminal = await manager.wait("default", submitted.id, 3000);
    expect(terminal.sandboxCreatePending).toBe(true);
    expect(terminal.cleanupUncertain).toBe(true);
    expect(fake.sandboxes.get("sb-1")?.terminated).toBe(false);
    expect(projectCostSummary("default").spentUsd).toBeCloseTo(submitted.reservationUsd);

    discoveryFails = false;
    const recovered = new DurableModalJobManager(factory);
    await recovered.recoverProject("default");
    expect(recovered.get("default", submitted.id)).toMatchObject({
      sandboxId: "sb-1", sandboxCreatePending: false, cleanupUncertain: true,
    });
    await recovered.recoverProject("default");
    expect(fake.sandboxes.get("sb-1")?.terminated).toBe(true);
    expect(recovered.get("default", submitted.id).cleanupUncertain).toBeUndefined();
    expect(fake.createParams).toHaveLength(1);
    expect(sessionCostSummary(owner.sessionId, "default").entries).toHaveLength(1);
    expect(projectCostSummary("default").spentUsd).toBeCloseTo(submitted.reservationUsd);
  });

  it("keeps failed termination recoverable and counts the full hold exactly once", async () => {
    const fake = new FakeModal();
    fake.terminateFailures.push(1);
    const manager = new DurableModalJobManager(fake.factory);
    const submitted = manager.submit("default", { command: "work" }, owner);
    const job = await manager.wait("default", submitted.id, 3000);
    const sandbox = [...fake.sandboxes.values()][0]!;
    expect(job.state).toBe("succeeded");
    expect(sandbox.terminated).toBe(false);
    expect(job.sandboxTerminatedAt).toBeUndefined();
    expect(job.cleanupUncertain).toBe(true);
    expect(job.accounting).toMatchObject({ reconciled: true, conservative: true, estimatedCostUsd: submitted.reservationUsd });
    expect(projectCostSummary("default").spentUsd).toBeCloseTo(submitted.reservationUsd);
    expect(listComputeReservations("default")).toEqual([]);
    expect(manager.store.events("default", job.id).some((event) => event.type === "cleanup_pending")).toBe(true);

    const recovered = new DurableModalJobManager(fake.factory);
    await recovered.recoverProject("default");
    expect(sandbox.terminated).toBe(true);
    expect(recovered.get("default", job.id).sandboxTerminatedAt).toBeTypeOf("number");
    expect(recovered.get("default", job.id).cleanupUncertain).toBeUndefined();
    await recovered.recoverProject("default");
    expect(projectCostSummary("default").spentUsd).toBeCloseTo(submitted.reservationUsd);
  });

  it("prices GPU, CPU and RAM separately without multiplying host resources by GPU count", () => {
    expect(hourlyEstimate(resolveInstance("cpu")!, 1)).toBeCloseTo(0.189936, 8);
    expect(hourlyEstimate(resolveInstance("t4")!, 1)).toBeCloseTo(1.06632, 8);
    expect(hourlyEstimate(resolveInstance("t4")!, 2)).toBeCloseTo(1.65672, 8);
    const quote = publicInstanceCatalog().find((spec) => spec.id === "t4")!;
    expect(quote.pricePerHour).toBeCloseTo(1.06632, 8);
    expect(quote.pricing.cpuPerHour + quote.pricing.memoryPerHour + 2 * quote.pricing.gpuPerHour)
      .toBeCloseTo(hourlyEstimate(resolveInstance("t4")!, 2), 8);
    expect(worstCaseReservationUsd({ command: "work", instance: "t4", gpuCount: 2, timeoutSec: 3600 }))
      .toBeCloseTo(1.65672 * 1.1, 8);
  });

  it("refuses a queued job admitted using an obsolete lower price before creating resources", async () => {
    const fake = new FakeModal();
    const manager = new DurableModalJobManager(fake.factory);
    const pause = vi.spyOn(manager as any, "schedule").mockImplementation(() => {});
    const submitted = manager.submit("default", { command: "work" }, owner);
    manager.store.update("default", submitted.id, (job) => { job.reservationUsd /= 2; });
    pause.mockRestore();
    await manager.recoverProject("default");
    const terminal = await manager.wait("default", submitted.id, 3000);
    expect(terminal.error?.code).toBe("PRICE_CHANGED");
    expect(fake.sandboxes.size).toBe(0);
    expect(listComputeReservations("default")).toEqual([]);
  });
});

describe("Modal local file protections", () => {
  it.each(["lead", "subagent", "api"] as const)("rejects protected output before %s admission", (submittedBy) => {
    fs.mkdirSync(path.join(root(), "user_data"), { recursive: true });
    const file = path.join(root(), "user_data", "input.csv");
    fs.writeFileSync(file, "original");
    const manager = new DurableModalJobManager(new FakeModal().factory);
    expect(() => manager.submit("default", { command: "work", filesOut: ["user_data/input.csv"] }, { ...owner, submittedBy }))
      .toThrow(/protected project path/);
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(listComputeReservations("default")).toEqual([]);
  });

  it("checks glob discoveries before installing any outputs", async () => {
    fs.mkdirSync(path.join(root(), "user_data"), { recursive: true });
    fs.writeFileSync(path.join(root(), "user_data", "input.csv"), "original");
    fs.writeFileSync(path.join(root(), "result.txt"), "old result");
    const sandbox = new FakeSandbox("sb-guard", { kind: "success" });
    sandbox.filesystem.files.set("/workspace/user_data/input.csv", Buffer.from("overwrite"));
    sandbox.filesystem.files.set("/workspace/result.txt", Buffer.from("new result"));
    await expect(collectOutputs({ sandbox, sandboxRoot: root(), stagingDir: path.join(PROJECTS_ROOT, "staging"), patterns: ["**"], checked }))
      .rejects.toMatchObject({ code: "PROTECTED_OUTPUT" });
    expect(fs.readFileSync(path.join(root(), "user_data", "input.csv"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(root(), "result.txt"), "utf8")).toBe("old result");
  });

  it("honors protection changes made while a download is in progress", async () => {
    const sandbox = new FakeSandbox("sb-policy", { kind: "success" });
    sandbox.filesystem.files.set("/workspace/result.txt", Buffer.from("new result"));
    fs.writeFileSync(path.join(root(), "result.txt"), "original");
    const copy = sandbox.filesystem.copyToLocal.bind(sandbox.filesystem);
    sandbox.filesystem.copyToLocal = async (remote, local) => {
      await copy(remote, local);
      writeGuardPolicy(root(), { protectedPaths: ["result.txt"] });
    };
    await expect(collectOutputs({ sandbox, sandboxRoot: root(), stagingDir: path.join(PROJECTS_ROOT, "staging"), patterns: ["result.txt"], checked }))
      .rejects.toMatchObject({ code: "PROTECTED_OUTPUT" });
    expect(fs.readFileSync(path.join(root(), "result.txt"), "utf8")).toBe("original");
  });

  it.each([".pi", ".kady", ".kady-job"])("blocks input and output aliases into %s", async (reserved) => {
    fs.mkdirSync(path.join(root(), reserved), { recursive: true });
    fs.writeFileSync(path.join(root(), reserved, "marker.txt"), "application state");
    fs.mkdirSync(path.join(root(), "data"), { recursive: true });
    fs.symlinkSync(path.join(root(), reserved), path.join(root(), "data", "alias"), "junction");
    // Both a directly requested file and a link discovered during directory enumeration.
    expect(() => planInputs(root(), ["data/alias/marker.txt"])).toThrow(/reserved/);
    expect(() => planInputs(root(), ["data"])).toThrow(/reserved/);
    const sandbox = new FakeSandbox("sb-alias", { kind: "success" });
    sandbox.filesystem.files.set("/workspace/data/alias/marker.txt", Buffer.from("overwrite"));
    sandbox.filesystem.files.set("/workspace/data/alias/new/nested.txt", Buffer.from("new"));
    await expect(collectOutputs({ sandbox, sandboxRoot: root(), stagingDir: path.join(PROJECTS_ROOT, "staging"), patterns: ["data/**"], checked }))
      .rejects.toMatchObject({ code: "RESERVED_PATH" });
    expect(fs.readFileSync(path.join(root(), reserved, "marker.txt"), "utf8")).toBe("application state");
    expect(fs.existsSync(path.join(root(), reserved, "new"))).toBe(false);
  });

  it("protects raw data through an alias but permits normal in-project input symlinks", () => {
    fs.mkdirSync(path.join(root(), "user_data"), { recursive: true });
    fs.writeFileSync(path.join(root(), "user_data", "input.csv"), "original");
    fs.symlinkSync(path.join(root(), "user_data"), path.join(root(), "raw-alias"), "junction");
    expect(planInputs(root(), ["raw-alias/input.csv"]).manifest).toMatchObject([{ path: "raw-alias/input.csv" }]);
    const manager = new DurableModalJobManager(new FakeModal().factory);
    expect(() => manager.submit("default", { command: "work", filesOut: ["raw-alias/input.csv"] }, owner))
      .toThrow(/protected project path/);
    writeGuardPolicy(root(), { protectedPaths: [] });
    expect(planInputs(root(), ["raw-alias/input.csv"]).manifest).toHaveLength(1);
  });
});

describe("Modal remote log offsets", () => {
  const setLog = (sandbox: FakeSandbox, content: string, dropped: number) => {
    sandbox.filesystem.files.set("/workspace/.kady-job/stdout.log", Buffer.from(content));
    sandbox.filesystem.files.set("/workspace/.kady-job/stdout.log.meta", Buffer.from(JSON.stringify({ size: content.length, dropped })));
  };

  it("does not duplicate retained bytes after a gap, including after recovery", async () => {
    const store = new ModalJobStore();
    const job = persistedRunningJob({ id: "mj_gap_recovery", sandboxId: "sb-gap", sessionId: owner.sessionId });
    store.create(job);
    const sandbox = new FakeSandbox("sb-gap", { kind: "hang" });
    const first = new DurableModalJobManager(new FakeModal().factory, store);
    setLog(sandbox, "6789", 6);
    await (first as any).syncRemoteLogs("default", job.id, sandbox, {});
    expect(store.require("default", job.id).stdoutRemoteCursor).toBe(10);
    expect(store.require("default", job.id).stdoutBytes).toBe(4);
    const restarted = new DurableModalJobManager(new FakeModal().factory, store);
    store.resyncLogCounters("default", job.id);
    setLog(sandbox, "89AB", 8);
    await (restarted as any).syncRemoteLogs("default", job.id, sandbox, {});
    expect(store.readLog("default", job.id, "stdout").data).toBe("6789AB");
    expect(store.require("default", job.id).stdoutRemoteCursor).toBe(12);
    expect(store.events("default", job.id).filter((event) => event.type === "log_gap")).toHaveLength(1);
  });

  it("recovers a crash between a remote log append and its counter write", async () => {
    const store = new ModalJobStore();
    const job = persistedRunningJob({ id: "mj_gap_torn_append", sandboxId: "sb-gap", sessionId: owner.sessionId });
    store.create(job);
    const write = vi.spyOn(store, "write");
    write.mockImplementationOnce(ModalJobStore.prototype.write).mockImplementationOnce(() => { throw new Error("crash after append"); });
    expect(() => store.appendLog("default", job.id, "stdout", "6789", 6)).toThrow(/crash/);
    write.mockRestore();
    expect(fs.readFileSync(modalJobFiles("default", job.id).stdout, "utf8")).toBe("6789");
    store.resyncLogCounters("default", job.id);
    expect(store.require("default", job.id).stdoutRemoteCursor).toBe(10);
    const sandbox = new FakeSandbox("sb-gap", { kind: "hang" });
    setLog(sandbox, "89AB", 8);
    await (new DurableModalJobManager(new FakeModal().factory, store) as any).syncRemoteLogs("default", job.id, sandbox, {});
    expect(store.readLog("default", job.id, "stdout").data).toBe("6789AB");
  });
});
