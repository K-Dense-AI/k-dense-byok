import crypto from "node:crypto";
import path from "node:path";
import { modalConfigured } from "../config.ts";
import { listProjects, resolvePaths } from "../projects.ts";
import {
  listComputeReservations,
  reattributeModalJobCost,
  recordModalJobCost,
  releaseComputeReservation,
  reserveComputeBudget,
} from "../cost/ledger.ts";
import {
  DEFAULT_INSTANCE_ID,
  hourlyEstimate,
  resolveInstance,
  validateInstanceChain,
  worstCaseReservationUsd,
} from "./catalog.ts";
import {
  sdkModalAdapterFactory,
  type ModalAdapter,
  type ModalAdapterFactory,
  type ModalRemoteSandbox,
} from "./adapter.ts";
import {
  clearModalCache,
  prepareModalEnvironment,
  readModalCacheMetadata,
} from "./environment.ts";
import { ModalJobStore, modalJobFiles } from "./store.ts";
import { recordModalJobStep } from "../provenance/modal-steps.ts";
import {
  collectOutputs,
  normalizeTransferPath,
  planInputs,
  stageInputs,
} from "./transfer.ts";
import {
  isTerminalModalState,
  ModalCancellationError,
  ModalJobError,
  type ModalJob,
  type ModalJobOwner,
  type ModalJobRequest,
  type ModalJobResult,
  type ModalTerminalState,
} from "./types.ts";

export const DEFAULT_MODAL_TIMEOUT_SEC = 600;
export const MAX_MODAL_TIMEOUT_SEC = 24 * 60 * 60;
export const MAX_MODAL_BATCH_SIZE = 32;
const REMOTE_CONTROL_DIR = "/workspace/.kady-job";
const REMOTE_STATUS = `${REMOTE_CONTROL_DIR}/status.json`;
const REMOTE_STDOUT = `${REMOTE_CONTROL_DIR}/stdout.log`;
const REMOTE_STDERR = `${REMOTE_CONTROL_DIR}/stderr.log`;
const REMOTE_COMMAND = `${REMOTE_CONTROL_DIR}/command.sh`;
const REMOTE_WRAPPER = `${REMOTE_CONTROL_DIR}/wrapper.py`;
const REMOTE_LOG_CAP = 8 * 1024 * 1024;
/** How long cancel() waits for the worker to reach a terminal, reconciled state. */
const CANCEL_SETTLE_MS = 10_000;

interface ActiveRuntime {
  promise: Promise<void>;
  adapter?: ModalAdapter;
  sandbox?: ModalRemoteSandbox;
}

interface RemoteStatus {
  state?: "running" | "finished";
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
}

function boundedStrings(values: unknown, name: string, max: number): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > max || values.some((value) => typeof value !== "string")) {
    throw new ModalJobError("INVALID_REQUEST", `${name} must be an array of at most ${max} strings`);
  }
  return values.map((value) => String(value));
}

export function normalizeModalJobRequest(raw: ModalJobRequest): ModalJob["request"] {
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command || Buffer.byteLength(command) > 64 * 1024) {
    throw new ModalJobError(
      "INVALID_COMMAND",
      "command must be non-empty and at most 64 KiB",
    );
  }
  const timeoutSec = Math.floor(raw.timeoutSec ?? DEFAULT_MODAL_TIMEOUT_SEC);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_MODAL_TIMEOUT_SEC) {
    throw new ModalJobError(
      "INVALID_TIMEOUT",
      `timeoutSec must be between 1 and ${MAX_MODAL_TIMEOUT_SEC}`,
    );
  }
  const instance = raw.instance ?? DEFAULT_INSTANCE_ID;
  const gpuCount = raw.gpuCount ?? 1;
  const filesIn = boundedStrings(raw.filesIn, "filesIn", 128).map(normalizeTransferPath);
  const filesOut = boundedStrings(raw.filesOut, "filesOut", 128).map(normalizeTransferPath);
  const gpuFallback = boundedStrings(raw.gpuFallback, "gpuFallback", 7);
  const groupId = raw.groupId?.trim();
  if (groupId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(groupId)) {
    throw new ModalJobError("INVALID_GROUP_ID", "groupId contains unsupported characters");
  }
  const label = raw.label?.trim();
  if (label && label.length > 200) {
    throw new ModalJobError("INVALID_LABEL", "label must be at most 200 characters");
  }
  const environment = raw.environment?.trim();
  if (
    environment &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(environment)
  ) {
    throw new ModalJobError(
      "INVALID_ENVIRONMENT",
      "environment must be 1-64 letters, digits, dots, underscores, or hyphens",
    );
  }
  const cache = raw.cache ?? "project";
  if (cache !== "project" && cache !== "none") {
    throw new ModalJobError("INVALID_CACHE", 'cache must be "project" or "none"');
  }
  const request: ModalJob["request"] = {
    command,
    instance,
    gpuCount,
    timeoutSec,
    ...(gpuFallback.length ? { gpuFallback } : {}),
    ...(filesIn.length ? { filesIn } : {}),
    ...(filesOut.length ? { filesOut } : {}),
    ...(raw.image ? { image: raw.image } : {}),
    ...(environment ? { environment } : {}),
    cache,
    ...(groupId ? { groupId } : {}),
    ...(label ? { label } : {}),
  };
  validateInstanceChain(request);
  return request;
}

function mintJobId(): string {
  return `mj_${crypto.randomUUID().replaceAll("-", "")}`;
}

function mintGroupId(): string {
  return `mg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function sandboxName(projectId: string, jobId: string): string {
  const project = projectId.replace(/[^a-z0-9-]/g, "-").slice(0, 20);
  return `kady-${project}-${jobId.slice(-12)}`.slice(0, 63);
}

function ledgerSessionId(owner: ModalJobOwner, jobId: string): string {
  const raw = owner.sessionId || owner.subagentRunId || jobId;
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return /^[A-Za-z0-9]/.test(sanitized) ? sanitized : `modal-${jobId}`;
}

function wrapperSource(): string {
  return `import json, os, selectors, subprocess, time
ROOT = ${JSON.stringify(REMOTE_CONTROL_DIR)}
CAP = ${REMOTE_LOG_CAP}
STATUS = os.path.join(ROOT, "status.json")

def status(value):
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f)
        f.write("\\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATUS)

def append_bounded(file, data):
    with open(file, "ab") as f:
        f.write(data)
    size = os.path.getsize(file)
    if size > CAP:
        with open(file, "rb") as f:
            f.seek(-CAP, os.SEEK_END)
            kept = f.read()
        tmp = file + ".tmp"
        with open(tmp, "wb") as f:
            f.write(kept)
        os.replace(tmp, file)

os.makedirs(ROOT, exist_ok=True)
for name in ("stdout.log", "stderr.log"):
    open(os.path.join(ROOT, name), "ab").close()
started = time.time()
status({"state": "running", "startedAt": started})
p = subprocess.Popen(["sh", ${JSON.stringify(REMOTE_COMMAND)}], cwd="/workspace",
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ, "stdout.log")
sel.register(p.stderr, selectors.EVENT_READ, "stderr.log")
while sel.get_map():
    for key, _ in sel.select(timeout=0.5):
        data = os.read(key.fileobj.fileno(), 65536)
        if data:
            append_bounded(os.path.join(ROOT, key.data), data)
        else:
            sel.unregister(key.fileobj)
code = p.wait()
finished = time.time()
status({"state": "finished", "startedAt": started, "finishedAt": finished, "exitCode": code})
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorInfo(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ModalJobError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) {
    return { code: "TIMEOUT", message, retryable: true };
  }
  return { code: "REMOTE_FAILURE", message, retryable: true };
}

export class DurableModalJobManager {
  readonly store: ModalJobStore;
  private adapterFactory: ModalAdapterFactory;
  private requireCredentials: boolean;
  private active = new Map<string, ActiveRuntime>();
  private previousRemoteLogs = new Map<string, { stdout: string; stderr: string }>();
  private deletingProjects = new Set<string>();

  constructor(
    adapterFactory: ModalAdapterFactory = sdkModalAdapterFactory,
    store = new ModalJobStore(),
  ) {
    this.adapterFactory = adapterFactory;
    this.requireCredentials = adapterFactory === sdkModalAdapterFactory;
    this.store = store;
  }

  private key(projectId: string, jobId: string): string {
    return `${projectId}:${jobId}`;
  }

  submit(projectId: string, raw: ModalJobRequest, owner: ModalJobOwner): ModalJob {
    if (this.deletingProjects.has(projectId)) {
      throw new ModalJobError(
        "PROJECT_DELETING",
        "The project is being deleted and cannot accept new Modal jobs",
        409,
      );
    }
    if (this.requireCredentials && !modalConfigured()) {
      throw new ModalJobError(
        "NOT_CONFIGURED",
        "Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.",
        503,
      );
    }
    const request = normalizeModalJobRequest(raw);
    // Fail fast before budget commitment or remote work. The manager plans
    // again immediately before staging so queued jobs cannot use stale files.
    const inputPlan = planInputs(resolvePaths(projectId).sandbox, request.filesIn ?? []);
    const id = mintJobId();
    const reservationUsd = worstCaseReservationUsd(request);
    const sessionId = ledgerSessionId(owner, id);
    try {
      reserveComputeBudget({
        projectId,
        reservationId: id,
        sessionId,
        amountUsd: reservationUsd,
      });
    } catch (error) {
      if ((error as Error).name === "BudgetReservationError") {
        throw new ModalJobError("BUDGET_EXCEEDED", (error as Error).message, 402);
      }
      throw error;
    }
    const now = Date.now();
    const name = sandboxName(projectId, id);
    const job: ModalJob = {
      version: 1,
      id,
      projectId,
      state: "queued",
      request,
      owner: { ...owner, sessionId },
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      cancelRequested: false,
      reservationUsd,
      sandboxName: name,
      sandboxTags: {
        kady: "true",
        project: projectId,
        job: id,
        ...(request.groupId ? { group: request.groupId } : {}),
      },
      inputFiles: inputPlan.manifest,
      outputFiles: [],
      missingOutputs: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutBaseCursor: 0,
      stderrBaseCursor: 0,
      eventSeq: 0,
      accounting: { reconciled: false },
    };
    try {
      this.store.create(job);
    } catch (error) {
      releaseComputeReservation(projectId, id);
      throw error;
    }
    this.schedule(projectId, id, false);
    return this.store.require(projectId, id);
  }

  submitBatch(
    projectId: string,
    requests: ModalJobRequest[],
    owner: ModalJobOwner,
  ): { groupId: string; jobs: ModalJob[] } {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_MODAL_BATCH_SIZE) {
      throw new ModalJobError(
        "INVALID_BATCH",
        `Batch must contain 1-${MAX_MODAL_BATCH_SIZE} jobs`,
      );
    }
    const groupId = requests.find((request) => request.groupId)?.groupId ?? mintGroupId();
    const jobs: ModalJob[] = [];
    try {
      for (const request of requests) {
        jobs.push(this.submit(projectId, { ...request, groupId }, owner));
      }
    } catch (error) {
      for (const job of jobs) void this.cancel(projectId, job.id);
      throw error;
    }
    return { groupId, jobs };
  }

  get(projectId: string, jobId: string): ModalJob {
    return this.store.require(projectId, jobId);
  }

  list(
    projectId: string,
    filter: { state?: string; groupId?: string; sessionId?: string } = {},
  ): ModalJob[] {
    return this.store.list(projectId).filter(
      (job) =>
        (!filter.state || job.state === filter.state) &&
        (!filter.groupId || job.request.groupId === filter.groupId) &&
        (!filter.sessionId || job.owner.sessionId === filter.sessionId),
    );
  }

  groups(projectId: string) {
    const grouped = new Map<string, ModalJob[]>();
    for (const job of this.store.list(projectId)) {
      if (!job.request.groupId) continue;
      const jobs = grouped.get(job.request.groupId) ?? [];
      jobs.push(job);
      grouped.set(job.request.groupId, jobs);
    }
    return [...grouped.entries()].map(([groupId, jobs]) => {
      const active = jobs.find((job) => !isTerminalModalState(job.state));
      const status =
        active?.state ??
        (jobs.some((job) => job.state === "failed" || job.state === "lost")
          ? "failed"
          : jobs.every((job) => job.state === "cancelled")
            ? "cancelled"
            : "succeeded");
      return {
        id: groupId,
        groupId,
        label: jobs.find((job) => job.request.label)?.request.label ?? null,
        status,
        createdAt: Math.min(...jobs.map((job) => job.createdAt)),
        updatedAt: Math.max(...jobs.map((job) => job.updatedAt)),
        total: jobs.length,
        states: Object.fromEntries(
          [...new Set(jobs.map((job) => job.state))].map((state) => [
            state,
            jobs.filter((job) => job.state === state).length,
          ]),
        ),
        jobIds: jobs.map((job) => job.id),
      };
    });
  }

  group(projectId: string, groupId: string) {
    const jobs = this.list(projectId, { groupId });
    if (!jobs.length) throw new ModalJobError("GROUP_NOT_FOUND", `No such Modal group: ${groupId}`, 404);
    return { groupId, jobs };
  }

  async wait(
    projectId: string,
    jobId: string,
    timeoutMs = 0,
    signal?: AbortSignal,
  ): Promise<ModalJob> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    while (true) {
      const job = this.store.require(projectId, jobId);
      if (
        isTerminalModalState(job.state) &&
        job.accounting.reconciled &&
        !this.active.has(this.key(projectId, jobId))
      ) {
        return job;
      }
      if (signal?.aborted) throw new ModalCancellationError("Wait aborted");
      if (Date.now() >= deadline) return job;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async cancel(projectId: string, jobId: string): Promise<ModalJob> {
    let job = this.store.require(projectId, jobId);
    if (isTerminalModalState(job.state)) return job;
    if (!job.cancelRequested) {
      job = this.store.update(projectId, jobId, (current) => {
        current.cancelRequested = true;
        current.cancelRequestedAt = Date.now();
      });
      this.store.appendEvent(projectId, jobId, {
        type: "cancel_requested",
        state: job.state,
        message: "Cancellation requested",
      });
    }
    const runtime = this.active.get(this.key(projectId, jobId));
    if (runtime?.sandbox) {
      try {
        await runtime.sandbox.terminate();
      } catch {
        // The worker/recovery path still observes cancelRequested and finalizes.
      }
    } else if (!runtime) {
      await this.finish(projectId, jobId, "cancelled", new ModalCancellationError());
    }
    if (runtime) {
      // Only the worker can finalize a live job. Give it a bounded window so
      // callers see a terminal state and a released reservation, rather than
      // a job that still reports "running" right after they cancelled it.
      try {
        return await this.wait(projectId, jobId, CANCEL_SETTLE_MS);
      } catch {
        // Fall through to a plain read; cancellation is already recorded.
      }
    }
    return this.store.require(projectId, jobId);
  }

  retry(projectId: string, jobId: string, owner?: ModalJobOwner): ModalJob {
    const previous = this.store.require(projectId, jobId);
    if (!isTerminalModalState(previous.state)) {
      throw new ModalJobError("JOB_ACTIVE", "Only terminal Modal jobs can be retried", 409);
    }
    const retry = this.submit(projectId, previous.request, owner ?? previous.owner);
    return this.store.update(projectId, retry.id, (job) => {
      job.retryOf = previous.id;
    });
  }

  reattributeSubagentJobs(
    projectId: string,
    subagentRunId: string,
    parentSessionId: string,
  ): number {
    let changed = 0;
    for (const job of this.store.list(projectId)) {
      if (
        job.owner.subagentRunId !== subagentRunId ||
        job.owner.sessionId === parentSessionId
      ) {
        continue;
      }
      const priorSessionId = ledgerSessionId(job.owner, job.id);
      if (job.accounting.reconciled) {
        reattributeModalJobCost(
          projectId,
          job.id,
          priorSessionId,
          parentSessionId,
        );
      }
      this.store.update(projectId, job.id, (current) => {
        current.owner.sessionId = parentSessionId;
      });
      this.store.appendEvent(projectId, job.id, {
        type: "parent_attributed",
        state: job.state,
        message: "Subagent Modal job attributed to its parent chat session",
        data: { subagentRunId, parentSessionId },
      });
      changed++;
    }
    return changed;
  }

  result(projectId: string, jobId: string): ModalJobResult {
    const job = this.store.require(projectId, jobId);
    const stdout = this.store.readLog(
      projectId,
      jobId,
      "stdout",
      Math.max(job.stdoutBaseCursor, job.stdoutBytes - 1024 * 1024),
      1024 * 1024,
    ).data;
    const stderr = this.store.readLog(
      projectId,
      jobId,
      "stderr",
      Math.max(job.stderrBaseCursor, job.stderrBytes - 1024 * 1024),
      1024 * 1024,
    ).data;
    return { job, stdout, stderr };
  }

  cache(projectId: string) {
    return {
      cache: readModalCacheMetadata(projectId),
      canonicalFilesystem: "local-project-sandbox",
      cacheOnly: true,
    };
  }

  async clearCache(projectId: string) {
    const adapter = this.adapterFactory();
    try {
      return await clearModalCache(adapter, projectId);
    } finally {
      adapter.close();
    }
  }

  private schedule(projectId: string, jobId: string, recovering: boolean): void {
    const key = this.key(projectId, jobId);
    if (this.active.has(key)) return;
    const runtime: ActiveRuntime = { promise: Promise.resolve() };
    const task = recovering
      ? this.recoverJob(projectId, jobId, runtime)
      : this.executeJob(projectId, jobId, runtime);
    const promise = task
      .catch(async (error) => {
        const job = this.store.read(projectId, jobId);
        if (job && !isTerminalModalState(job.state)) {
          await this.finish(
            projectId,
            jobId,
            job.cancelRequested ? "cancelled" : recovering ? "lost" : "failed",
            job.cancelRequested ? new ModalCancellationError() : error,
          );
        }
      })
      .finally(() => {
        runtime.adapter?.close();
        this.active.delete(key);
        this.previousRemoteLogs.delete(key);
      });
    runtime.promise = promise;
    this.active.set(key, runtime);
  }

  private assertNotCancelled(projectId: string, jobId: string): ModalJob {
    const job = this.store.require(projectId, jobId);
    if (job.cancelRequested) throw new ModalCancellationError();
    return job;
  }

  private checked(
    projectId: string,
    jobId: string,
    sandbox?: ModalRemoteSandbox,
  ): <T>(promise: Promise<T>) => Promise<T> {
    return async <T>(promise: Promise<T>): Promise<T> => {
      const result = await promise;
      const job = this.store.require(projectId, jobId);
      if (job.cancelRequested) {
        if (sandbox) {
          try {
            await sandbox.terminate();
          } catch {
            // cancellation remains authoritative
          }
        }
        throw new ModalCancellationError();
      }
      return result;
    };
  }

  private async createSandbox(
    projectId: string,
    jobId: string,
    runtime: ActiveRuntime,
    adapter: ModalAdapter,
  ): Promise<ModalRemoteSandbox> {
    const job = this.assertNotCancelled(projectId, jobId);
    const chain = validateInstanceChain(job.request);
    let lastError: unknown;
    for (const spec of chain) {
      this.assertNotCancelled(projectId, jobId);
      let created: ModalRemoteSandbox | undefined;
      try {
        const environment = await this.checked(projectId, jobId)(
          prepareModalEnvironment(
            adapter,
            projectId,
            job.request.image,
            spec.defaultImage,
            job.request.environment,
            job.request.cache,
          ),
        );
        // Persisting happens synchronously immediately after create resolves,
        // before the cancellation check, so a concurrent abort can always find
        // and terminate the newly-created remote sandbox.
        const sandbox = await adapter.createSandbox(environment, {
          instance: spec,
          gpuCount: job.request.gpuCount,
          timeoutMs: job.request.timeoutSec * 1000,
          name: job.sandboxName,
          tags: job.sandboxTags,
        });
        created = sandbox;
        runtime.sandbox = sandbox;
        const createdAt = Date.now();
        this.store.update(projectId, jobId, (current) => {
          current.sandboxId = sandbox.id;
          current.sandboxCreatedAt = createdAt;
          current.effectiveInstance = spec.id;
          current.effectiveGpu = spec.gpu;
          current.pricePerHour = hourlyEstimate(spec, current.request.gpuCount);
        });
        this.store.appendEvent(projectId, jobId, {
          type: "sandbox_created",
          state: "preparing",
          message: `Created Modal sandbox ${sandbox.id}`,
          data: { sandboxId: sandbox.id, instance: spec.id },
        });
        if (this.store.require(projectId, jobId).cancelRequested) {
          await sandbox.terminate();
          throw new ModalCancellationError();
        }
        return sandbox;
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        // A sandbox created just before this failure would keep billing while
        // we move on to the next instance in the chain. Its identity is also
        // cleared so a later successful attempt reconciles against its own
        // creation window rather than this abandoned one.
        if (created) {
          try {
            await created.terminate();
          } catch {
            // best effort; the next attempt still needs to proceed
          }
          if (runtime.sandbox === created) runtime.sandbox = undefined;
          this.store.update(projectId, jobId, (current) => {
            current.sandboxId = undefined;
            current.sandboxCreatedAt = undefined;
            current.sandboxTerminatedAt = undefined;
          });
        }
        lastError = error;
        this.store.appendEvent(projectId, jobId, {
          type: "instance_fallback",
          state: "preparing",
          message: `Instance ${spec.id} was unavailable`,
          data: { instance: spec.id, error: errorInfo(error).message },
        });
      }
    }
    throw new ModalJobError(
      "SANDBOX_CREATE_FAILED",
      `Could not create a Modal sandbox with any configured instance: ${errorInfo(lastError).message}`,
      502,
      true,
    );
  }

  private async syncRemoteLogs(
    projectId: string,
    jobId: string,
    sandbox: ModalRemoteSandbox,
    recovered = false,
  ): Promise<void> {
    const key = this.key(projectId, jobId);
    const previous = this.previousRemoteLogs.get(key) ?? { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      const remotePath = stream === "stdout" ? REMOTE_STDOUT : REMOTE_STDERR;
      let current: string;
      try {
        current = await this.checked(projectId, jobId, sandbox)(
          sandbox.filesystem.readText(remotePath),
        );
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        continue;
      }
      const old = previous[stream];
      let delta = "";
      if (!old) {
        const job = this.store.require(projectId, jobId);
        const localBytes = stream === "stdout" ? job.stdoutBytes : job.stderrBytes;
        const localBase =
          stream === "stdout" ? job.stdoutBaseCursor : job.stderrBaseCursor;
        if (localBytes === 0) {
          delta = current;
        } else if (recovered) {
          const currentBuffer = Buffer.from(current);
          if (localBase === 0 && localBytes <= currentBuffer.length) {
            delta = currentBuffer.subarray(localBytes).toString("utf-8");
          } else {
            // Both local and remote logs are bounded. Compare retained tails
            // after a restart so content captured before the crash is not
            // appended a second time.
            const tailStart = Math.max(localBase, localBytes - 1024 * 1024);
            const localTail = this.store.readLog(
              projectId,
              jobId,
              stream,
              tailStart,
              1024 * 1024,
            ).data;
            const max = Math.min(localTail.length, current.length);
            let overlap = 0;
            for (let size = max; size > 0; size--) {
              if (localTail.slice(-size) === current.slice(0, size)) {
                overlap = size;
                break;
              }
            }
            delta = current.slice(overlap);
          }
        }
      } else if (current.startsWith(old)) {
        delta = current.slice(old.length);
      } else {
        // The remote bounded file rolled. Find the longest overlap between the
        // old suffix and new prefix, then append only unseen bytes.
        const max = Math.min(old.length, current.length);
        let overlap = 0;
        for (let size = max; size > 0; size--) {
          if (old.slice(-size) === current.slice(0, size)) {
            overlap = size;
            break;
          }
        }
        delta = current.slice(overlap);
      }
      if (delta) this.store.appendLog(projectId, jobId, stream, delta);
      previous[stream] = current;
    }
    this.previousRemoteLogs.set(key, previous);
  }

  private async readRemoteStatus(
    projectId: string,
    jobId: string,
    sandbox: ModalRemoteSandbox,
  ): Promise<RemoteStatus | null> {
    try {
      const raw = await this.checked(projectId, jobId, sandbox)(
        sandbox.filesystem.readText(REMOTE_STATUS),
      );
      return JSON.parse(raw) as RemoteStatus;
    } catch (error) {
      if (error instanceof ModalCancellationError) throw error;
      return null;
    }
  }

  private async collectAndFinish(
    projectId: string,
    jobId: string,
    sandbox: ModalRemoteSandbox,
    exitCode: number,
  ): Promise<void> {
    this.store.transition(projectId, jobId, "collecting", (job) => {
      job.exitCode = exitCode;
    });
    const files = modalJobFiles(projectId, jobId);
    const job = this.store.require(projectId, jobId);
    const output = await collectOutputs({
      sandbox,
      sandboxRoot: resolvePaths(projectId).sandbox,
      stagingDir: path.join(files.staging, "outputs"),
      patterns: job.request.filesOut ?? [],
      checked: this.checked(projectId, jobId, sandbox),
    });
    this.store.update(projectId, jobId, (current) => {
      current.outputFiles = output.files;
      current.missingOutputs = output.missing;
    });
    if (exitCode === 0) {
      await this.finish(projectId, jobId, "succeeded");
    } else {
      await this.finish(
        projectId,
        jobId,
        "failed",
        new ModalJobError(
          "NONZERO_EXIT",
          `Remote command exited with code ${exitCode}`,
          422,
          false,
        ),
      );
    }
  }

  private async executeJob(
    projectId: string,
    jobId: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    const adapter = this.adapterFactory();
    runtime.adapter = adapter;
    let sandbox: ModalRemoteSandbox | undefined;
    try {
      this.assertNotCancelled(projectId, jobId);
      this.store.transition(projectId, jobId, "preparing");
      sandbox = await this.createSandbox(projectId, jobId, runtime, adapter);
      const checked = this.checked(projectId, jobId, sandbox);
      const job = this.store.require(projectId, jobId);
      const inputPlan = planInputs(resolvePaths(projectId).sandbox, job.request.filesIn ?? []);
      this.store.update(projectId, jobId, (current) => {
        current.inputFiles = inputPlan.manifest;
      });
      await stageInputs(sandbox, inputPlan, checked);
      await checked(
        sandbox.filesystem.makeDirectory(REMOTE_CONTROL_DIR, { createParents: true }),
      );
      await checked(sandbox.filesystem.writeText(job.request.command + "\n", REMOTE_COMMAND));
      await checked(sandbox.filesystem.writeText(wrapperSource(), REMOTE_WRAPPER));
      this.store.transition(projectId, jobId, "running");
      const process = await checked(
        sandbox.exec(["python3", REMOTE_WRAPPER], {
          stdout: "ignore",
          stderr: "ignore",
          workdir: "/workspace",
          timeoutMs: job.request.timeoutSec * 1000,
        }),
      );
      let settled = false;
      let wrapperExit = 0;
      let wrapperError: unknown;
      const waiter = process
        .wait()
        .then((code) => {
          wrapperExit = code;
          settled = true;
        })
        .catch((error) => {
          wrapperError = error;
          settled = true;
        });
      while (!settled) {
        await checked(sleep(500));
        await this.syncRemoteLogs(projectId, jobId, sandbox);
      }
      await checked(waiter);
      await this.syncRemoteLogs(projectId, jobId, sandbox);
      if (wrapperError) throw wrapperError;
      if (wrapperExit !== 0) {
        throw new ModalJobError(
          "WRAPPER_FAILED",
          `Durable Modal job wrapper exited with code ${wrapperExit}`,
          502,
          true,
        );
      }
      const status = await this.readRemoteStatus(projectId, jobId, sandbox);
      if (status?.state !== "finished" || !Number.isInteger(status.exitCode)) {
        throw new ModalJobError(
          "STATUS_MISSING",
          "Modal sandbox finished without a valid durable status record",
          502,
          true,
        );
      }
      await this.collectAndFinish(projectId, jobId, sandbox, status.exitCode!);
    } catch (error) {
      if (
        error instanceof ModalCancellationError ||
        this.store.require(projectId, jobId).cancelRequested
      ) {
        await this.finish(projectId, jobId, "cancelled", new ModalCancellationError());
      } else {
        await this.finish(projectId, jobId, "failed", error);
      }
    } finally {
      // createSandbox can throw *after* creating and persisting a sandbox (a
      // cancel racing creation), so the local binding is not the source of
      // truth for whether one exists.
      const created = sandbox ?? runtime.sandbox;
      if (created) {
        try {
          await created.terminate();
        } catch {
          // terminal state and accounting remain durable
        }
        this.store.update(projectId, jobId, (job) => {
          job.sandboxTerminatedAt ??= Date.now();
        });
      }
      // Unconditional: finish() defers reconciliation to here whenever a
      // sandbox was created, so skipping it strands the budget reservation
      // for the life of the process. It no-ops when already reconciled.
      await this.reconcile(projectId, jobId);
    }
  }

  private async recoverJob(
    projectId: string,
    jobId: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    const existing = this.store.require(projectId, jobId);
    if (isTerminalModalState(existing.state)) {
      await this.reconcile(projectId, jobId);
      return;
    }
    if (!existing.sandboxId) {
      await this.executeJob(projectId, jobId, runtime);
      return;
    }
    const adapter = this.adapterFactory();
    runtime.adapter = adapter;
    let sandbox: ModalRemoteSandbox;
    try {
      sandbox = await adapter.fromId(existing.sandboxId);
      runtime.sandbox = sandbox;
      if (this.store.require(projectId, jobId).cancelRequested) {
        await sandbox.terminate();
        throw new ModalCancellationError();
      }
    } catch (error) {
      if (
        error instanceof ModalCancellationError ||
        this.store.require(projectId, jobId).cancelRequested
      ) {
        await this.finish(projectId, jobId, "cancelled", new ModalCancellationError());
      } else {
        await this.finish(
          projectId,
          jobId,
          "lost",
          new ModalJobError(
            "SANDBOX_LOST",
            `Could not reattach Modal sandbox ${existing.sandboxId}: ${errorInfo(error).message}`,
            502,
            false,
          ),
        );
      }
      await this.reconcile(projectId, jobId);
      return;
    }
    try {
      while (true) {
        this.assertNotCancelled(projectId, jobId);
        await this.syncRemoteLogs(projectId, jobId, sandbox, true);
        const status = await this.readRemoteStatus(projectId, jobId, sandbox);
        if (status?.state === "finished" && Number.isInteger(status.exitCode)) {
          await this.collectAndFinish(projectId, jobId, sandbox, status.exitCode!);
          break;
        }
        const sandboxExit = await this.checked(projectId, jobId, sandbox)(sandbox.poll());
        if (sandboxExit !== null) {
          throw new ModalJobError(
            "SANDBOX_LOST",
            "Recovered sandbox terminated without a final status record",
            502,
          );
        }
        const job = this.store.require(projectId, jobId);
        const deadline = (job.sandboxCreatedAt ?? job.createdAt) + job.request.timeoutSec * 1000;
        if (Date.now() > deadline + 5000) {
          throw new ModalJobError("TIMEOUT", "Recovered Modal sandbox exceeded its timeout", 504);
        }
        await this.checked(projectId, jobId, sandbox)(sleep(1000));
      }
    } catch (error) {
      if (
        error instanceof ModalCancellationError ||
        this.store.require(projectId, jobId).cancelRequested
      ) {
        await this.finish(projectId, jobId, "cancelled", new ModalCancellationError());
      } else {
        const info = errorInfo(error);
        await this.finish(
          projectId,
          jobId,
          info.code === "SANDBOX_LOST" ? "lost" : "failed",
          error,
        );
      }
    } finally {
      try {
        await sandbox.terminate();
      } catch {
        // best effort
      }
      this.store.update(projectId, jobId, (job) => {
        job.sandboxTerminatedAt ??= Date.now();
      });
      await this.reconcile(projectId, jobId);
    }
  }

  private async finish(
    projectId: string,
    jobId: string,
    state: ModalTerminalState,
    error?: unknown,
  ): Promise<void> {
    const current = this.store.require(projectId, jobId);
    if (isTerminalModalState(current.state)) {
      await this.reconcile(projectId, jobId);
      return;
    }
    const info = error ? errorInfo(error) : null;
    this.store.transition(projectId, jobId, state, (job) => {
      if (info) job.error = info;
    });
    // The single terminal transition, including recovery paths: record the
    // job as a `compute` provenance step from the transfer layer's own hashes.
    recordModalJobStep(this.store.require(projectId, jobId), (err) =>
      console.warn("[modal] failed to record provenance step", err),
    );
    if (!current.sandboxCreatedAt) await this.reconcile(projectId, jobId);
  }

  private async reconcile(projectId: string, jobId: string): Promise<void> {
    const job = this.store.require(projectId, jobId);
    if (job.accounting.reconciled || !isTerminalModalState(job.state)) return;
    let costUsd = 0;
    let entryId: string | undefined;
    if (job.sandboxCreatedAt && job.pricePerHour !== undefined) {
      const endedAt = job.sandboxTerminatedAt ?? job.finishedAt ?? Date.now();
      // Modal enforces timeoutSec as the sandbox's maximum lifetime. Cap local
      // observation lag (for example, a slow terminate RPC) so actual
      // reconciliation cannot exceed the strict worst-case reservation.
      const elapsedMs = Math.min(
        job.request.timeoutSec * 1000,
        Math.max(1, endedAt - job.sandboxCreatedAt),
      );
      costUsd = (elapsedMs / 3_600_000) * job.pricePerHour;
      const entry = recordModalJobCost({
        projectId,
        sessionId: job.owner.sessionId,
        jobId,
        costUsd,
        model: `modal:${job.effectiveInstance ?? job.request.instance}`,
        terminalState: job.state,
      });
      entryId = entry?.entryId;
    }
    releaseComputeReservation(projectId, jobId);
    this.store.update(projectId, jobId, (current) => {
      current.accounting = {
        reconciled: true,
        estimatedCostUsd: costUsd,
        ...(entryId ? { ledgerEntryId: entryId } : {}),
      };
    });
    this.store.appendEvent(projectId, jobId, {
      type: "accounting_reconciled",
      state: job.state,
      message: "Estimated Modal compute cost reconciled",
      data: {
        reservedUsd: job.reservationUsd,
        estimatedCostUsd: costUsd,
        estimated: true,
      },
    });
  }

  async recoverProject(projectId: string): Promise<void> {
    const jobs = this.store.list(projectId);
    const jobIds = new Set(jobs.map((job) => job.id));
    // A process crash in the tiny interval between reservation creation and
    // atomic job creation can leave an orphan hold. No remote resource could
    // have been created at that point, so startup recovery safely releases it.
    for (const reservation of listComputeReservations(projectId)) {
      if (!jobIds.has(reservation.id)) {
        releaseComputeReservation(projectId, reservation.id);
      }
    }
    for (const job of jobs) {
      if (isTerminalModalState(job.state)) {
        if (!job.accounting.reconciled) await this.reconcile(projectId, job.id);
      } else if (this.requireCredentials && !modalConfigured()) {
        this.store.appendEvent(projectId, job.id, {
          type: "recovery_deferred",
          state: job.state,
          message: "Modal recovery deferred until credentials are configured",
        });
      } else {
        this.schedule(projectId, job.id, true);
      }
    }
  }

  async recoverAllProjects(): Promise<void> {
    for (const project of listProjects()) await this.recoverProject(project.id);
  }

  async cancelProject(projectId: string): Promise<void> {
    this.deletingProjects.add(projectId);
    const jobs = this.store.list(projectId).filter((job) => !isTerminalModalState(job.state));
    await Promise.allSettled(jobs.map((job) => this.cancel(projectId, job.id)));
    const promises = [...this.active.entries()]
      .filter(([key]) => key.startsWith(`${projectId}:`))
      .map(([, runtime]) => runtime.promise);
    await Promise.allSettled(promises);
  }

  /** Re-open admission if project deletion failed before removing the project. */
  resumeProject(projectId: string): void {
    this.deletingProjects.delete(projectId);
  }
}

export const modalJobManager = new DurableModalJobManager();
