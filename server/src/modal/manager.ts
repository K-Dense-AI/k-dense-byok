import crypto from "node:crypto";
import fs from "node:fs";
import { protectedApprovalReservations } from "./approval-reservations.ts";
import { jsonDigest } from "../canonical-json.ts";
import { approvedBatchDir, approvedInputPlan, approvedJobDigest, assertApprovedJob, batchCancelled, batchCommitted, publishExclusiveJson, readManagedJson } from "./approved.ts";
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
  sandboxLifetimeSec,
  validateImageRequest,
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
  type ModalJobApproval,
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
/** Error codes for which trying another instance in the fallback chain cannot help. */
const NON_FALLBACK_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "IMAGE_BUILD_FAILED",
  "INVALID_REQUEST",
  "INVALID_IMAGE",
  "INVALID_ENVIRONMENT",
  "NOT_CONFIGURED",
  "PRICE_CHANGED",
]);

interface ActiveRuntime {
  promise: Promise<void>;
  adapter?: ModalAdapter;
  sandbox?: ModalRemoteSandbox;
  /** Last remote log state seen per stream, to skip reads when nothing changed. */
  logMeta?: Partial<Record<"stdout" | "stderr", { size: number; dropped: number }>>;
}

interface RemoteLogMeta {
  dropped?: number;
  size?: number;
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
  const image = validateImageRequest(raw.image);
  const request: ModalJob["request"] = {
    command,
    instance,
    gpuCount,
    timeoutSec,
    ...(gpuFallback.length ? { gpuFallback } : {}),
    ...(filesIn.length ? { filesIn } : {}),
    ...(filesOut.length ? { filesOut } : {}),
    ...(image ? { image } : {}),
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

DROPPED = {"stdout.log": 0, "stderr.log": 0}

def write_meta(name, size):
    # Logical offset of the retained bytes: the reader appends
    # file[localTotal - dropped:] and never has to search for an overlap.
    meta = os.path.join(ROOT, name + ".meta")
    tmp = meta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"dropped": DROPPED[name], "size": size}, f)
    os.replace(tmp, meta)

def append_bounded(name, data):
    file = os.path.join(ROOT, name)
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
        DROPPED[name] += size - len(kept)
        size = len(kept)
    write_meta(name, size)

os.makedirs(ROOT, exist_ok=True)
for name in ("stdout.log", "stderr.log"):
    open(os.path.join(ROOT, name), "ab").close()
    write_meta(name, os.path.getsize(os.path.join(ROOT, name)))
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
            append_bounded(key.data, data)
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
  private deletingProjects = new Set<string>();
  private terminalListeners = new Set<(job: ModalJob) => void>();

  onTerminal(listener: (job: ModalJob) => void): () => void {
    this.terminalListeners.add(listener);
    return () => { this.terminalListeners.delete(listener); };
  }

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

  /** Test-only: drive the process-wide manager with a fake adapter (`null` restores the SDK). */
  setAdapterFactoryForTests(factory: ModalAdapterFactory | null): void {
    this.adapterFactory = factory ?? sdkModalAdapterFactory;
    this.requireCredentials = factory === null;
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
      for (const job of jobs) {
        void this.cancel(projectId, job.id).catch((cancelError) =>
          console.warn("[modal] batch rollback cancel failed", job.id, cancelError),
        );
      }
      throw error;
    }
    return { groupId, jobs };
  }

  /** Trusted notebook path: all holds/jobs are durable before a shared admission
   * gate permits any remote work. Stable ids make replay after a crash safe.
   * Ordinary modal tool/API requests cannot supply the approval metadata. */
  submitApprovedBatch(projectId: string, batchId: string, items: { id: string; request: ModalJobRequest; approval: ModalJobApproval }[], owner: ModalJobOwner): ModalJob[] {
    const dir = approvedBatchDir(projectId, batchId);
    if (this.deletingProjects.has(projectId)) throw new ModalJobError("PROJECT_DELETING", "Project is being deleted", 409);
    if (this.requireCredentials && !modalConfigured()) throw new ModalJobError("NOT_CONFIGURED", "Configure Modal credentials in Settings before approving remote work", 503);
    if (!items.length || items.length > 16 || new Set(items.map((i) => i.id)).size !== items.length || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(owner.sessionId)) throw new ModalJobError("INVALID_APPROVED_BATCH", "Invalid approved batch");
    if (batchCancelled(projectId, batchId)) throw new ModalCancellationError();
    const prepared = items.map((item): ModalJob => {
      modalJobFiles(projectId, item.id); // validate before creating budget holds
      const request = normalizeModalJobRequest({ ...item.request, groupId: batchId });
      if (request.gpuFallback?.length || request.environment || request.cache !== "none" || item.approval.batchId !== batchId) throw new ModalJobError("INVALID_APPROVED_BATCH", "Approved work cannot add fallbacks, named environments or a mutable project cache");
      const reservationUsd = worstCaseReservationUsd(request);
      if (!Number.isFinite(item.approval.maxReservationUsd) || reservationUsd > item.approval.maxReservationUsd + 1e-12) throw new ModalJobError("PRICE_CHANGED", "Resource pricing exceeds the approved estimate; review a new workflow", 409);
      const now = Date.now();
      return { version: 1, id: item.id, projectId, request, owner: { ...owner }, approval: item.approval,
        state: "queued", createdAt: now, updatedAt: now, queuedAt: now, cancelRequested: false,
        reservationUsd, sandboxName: sandboxName(projectId, item.id), sandboxTags: { kady: "true", project: projectId, job: item.id, group: batchId },
        inputFiles: item.approval.inputs, outputFiles: [], missingOutputs: [], stdoutBytes: 0, stderrBytes: 0, stdoutBaseCursor: 0, stderrBaseCursor: 0, eventSeq: 0, accounting: { reconciled: false } };
    });
    if (batchCommitted(projectId, batchId)) {
      for (const wanted of prepared) {
        const actual = this.store.require(projectId, wanted.id);
        assertApprovedJob(actual);
        if (approvedJobDigest(actual) !== approvedJobDigest(wanted)) throw new ModalJobError("APPROVAL_CHANGED", "Approved job definition changed", 409);
        if (!isTerminalModalState(actual.state)) this.schedule(projectId, actual.id, true);
      }
      return prepared.map((j) => this.store.require(projectId, j.id));
    }
    const gate = { version: 1, batchId, jobs: Object.fromEntries(prepared.map((job) => [job.id, approvedJobDigest(job)])) };
    const intent = path.join(dir, "intent.json");
    if (fs.existsSync(intent)) {
      if (jsonDigest(readManagedJson(intent)) !== jsonDigest(gate)) throw new ModalJobError("APPROVAL_CHANGED", "Admission intent no longer matches the approved batch", 409);
    } else publishExclusiveJson(intent, gate);
    try {
      // No awaits and no scheduling in this admission section: the one backend
      // that owns Modal cannot interleave another reservation or worker here.
      for (const job of prepared) {
        const existing = this.store.read(projectId, job.id);
        if (existing && (isTerminalModalState(existing.state) || approvedJobDigest(existing) !== approvedJobDigest(job))) throw new ModalJobError("APPROVAL_CHANGED", "Partial admission was cancelled or changed; review a new workflow", 409);
        reserveComputeBudget({ projectId, reservationId: job.id, sessionId: owner.sessionId, amountUsd: job.reservationUsd });
      }
      for (const job of prepared) if (!this.store.read(projectId, job.id)) this.store.create(job);
      publishExclusiveJson(path.join(dir, "committed.json"), gate);
    } catch (error) {
      for (const job of prepared) {
        const existing = this.store.read(projectId, job.id);
        if (existing?.approval?.batchId === batchId) void this.cancel(projectId, job.id).catch(() => {});
        else if (!existing) releaseComputeReservation(projectId, job.id);
      }
      if ((error as Error).name === "BudgetReservationError") throw new ModalJobError("BUDGET_EXCEEDED", (error as Error).message, 402);
      throw error;
    }
    for (const job of prepared) this.schedule(projectId, job.id, false);
    return prepared.map((j) => this.store.require(projectId, j.id));
  }

  async cancelApprovedBatch(projectId: string, batchId: string): Promise<void> {
    const marker = path.join(approvedBatchDir(projectId, batchId), "cancelled.json");
    if (!fs.existsSync(marker)) {
      try { publishExclusiveJson(marker, { cancelledAt: Date.now() }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    await Promise.all(this.list(projectId, { groupId: batchId }).filter((job) => job.approval?.batchId === batchId).map((job) => this.cancel(projectId, job.id)));
  }

  get(projectId: string, jobId: string): ModalJob {
    return this.store.require(projectId, jobId);
  }

  list(
    projectId: string,
    filter: { state?: string; groupId?: string; sessionId?: string } = {},
  ): ModalJob[] {
    return this.filterJobs(this.store.list(projectId), filter);
  }

  /** Apply the `list()` filter to an already-loaded job array. */
  filterJobs(
    jobs: ModalJob[],
    filter: { state?: string; groupId?: string; sessionId?: string } = {},
  ): ModalJob[] {
    return jobs.filter(
      (job) =>
        (!filter.state || job.state === filter.state) &&
        (!filter.groupId || job.request.groupId === filter.groupId) &&
        (!filter.sessionId || job.owner.sessionId === filter.sessionId),
    );
  }

  groups(projectId: string) {
    return this.groupsFrom(this.store.list(projectId));
  }

  /** Group summaries from an already-loaded job array (one disk read per poll). */
  groupsFrom(all: ModalJob[]) {
    const grouped = new Map<string, ModalJob[]>();
    for (const job of all) {
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
          : jobs.some((job) => job.state === "cancelled")
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

  /**
   * Wait until the job is terminal and reconciled. `timeoutMs` undefined waits
   * indefinitely; `0` performs a single read and returns the current state.
   */
  async wait(
    projectId: string,
    jobId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ModalJob> {
    const deadline =
      timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, timeoutMs);
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
    let runtime = this.active.get(this.key(projectId, jobId));
    if (!runtime && job.sandboxId) {
      // No live worker owns this job (for example recovery was deferred
      // because Modal credentials were missing at boot). Reattach solely to
      // honour the cancellation: the recovery worker terminates the remote
      // sandbox and reconciles the hold, instead of this record being marked
      // cancelled while the sandbox keeps running and the reservation stays.
      this.schedule(projectId, jobId, true);
      runtime = this.active.get(this.key(projectId, jobId));
    }
    if (runtime?.sandbox) {
      try {
        await this.terminateAndRecord(projectId, jobId, runtime.sandbox);
      } catch {
        // The worker/recovery path still observes cancelRequested and finalizes.
      }
    } else if (!runtime) {
      const error = job.approval && job.state !== "queued" && !job.sandboxId
        ? new ModalJobError("LAUNCH_UNCERTAIN", "Interrupted launch cancelled; remote creation is unknown. Full approved estimate counted against the project budget conservatively.", 502)
        : new ModalCancellationError();
      await this.finish(projectId, jobId, "cancelled", error);
      // No worker exists to run the usual post-finish reconcile.
      await this.reconcile(projectId, jobId);
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
    if (previous.approval) throw new ModalJobError("WORKFLOW_APPROVAL_REQUIRED", "Create and approve a new robustness workflow to retry; this preserves every attempt and its budget", 409);
    if (!isTerminalModalState(previous.state)) {
      throw new ModalJobError("JOB_ACTIVE", "Only terminal Modal jobs can be retried", 409);
    }
    const retry = this.submit(projectId, previous.request, owner ?? previous.owner);
    return this.store.update(projectId, retry.id, (job) => {
      job.retryOf = previous.id;
    });
  }

  /**
   * Move every job a delegated child submitted under `subagentRef` — its
   * pi-subagents run id, or (pi-subagents ≥0.65, where children have no
   * per-process environment) the absolute path of its session file — onto the
   * parent chat session, cost included.
   */
  reattributeSubagentJobs(
    projectId: string,
    subagentRef: string,
    parentSessionId: string,
  ): number {
    let changed = 0;
    for (const job of this.store.list(projectId)) {
      const matches =
        job.owner.subagentRunId === subagentRef ||
        job.owner.subagentSessionFile === subagentRef;
      if (!matches || job.owner.sessionId === parentSessionId) continue;
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
        data: { subagentRef, parentSessionId },
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
          try {
            await this.finish(
              projectId,
              jobId,
              job.cancelRequested ? "cancelled" : recovering ? "lost" : "failed",
              job.cancelRequested ? new ModalCancellationError() : error,
            );
          } catch (finishError) {
            console.error("[modal] failed to finalize job", jobId, finishError);
          }
        }
        // Mirrors executeJob's finally. A worker that died before its own
        // reconcile — or a recovery worker whose adapter could not even be
        // built because credentials are missing — must not leave the budget
        // hold in place until the next restart.
        try {
          await this.reconcile(projectId, jobId);
        } catch (reconcileError) {
          console.error("[modal] failed to reconcile job", jobId, reconcileError);
        }
      })
      .finally(() => {
        runtime.adapter?.close();
        this.active.delete(key);
      })
      // Terminal handler: nothing above may surface as an unhandled rejection,
      // which would take the whole backend (every chat tab) down with it.
      .catch((error) => console.error("[modal] worker crashed", jobId, error));
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
    if (job.approval && worstCaseReservationUsd(job.request) > job.reservationUsd + 1e-12) throw new ModalJobError("PRICE_CHANGED", "Resource pricing exceeds this job's approved reservation", 409);
    let lastError: unknown;
    for (const spec of chain) {
      this.assertNotCancelled(projectId, jobId);
      let created: ModalRemoteSandbox | undefined;
      let createAttempted = false;
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
        createAttempted = true;
        // The sandbox outlives the command by a bounded transfer headroom so
        // staging and collection never eat into the command's own timeout.
        const sandbox = await adapter.createSandbox(environment, {
          instance: spec,
          gpuCount: job.request.gpuCount,
          timeoutMs: sandboxLifetimeSec(job.request.timeoutSec) * 1000,
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
          await this.terminateAndRecord(projectId, jobId, sandbox);
          throw new ModalCancellationError();
        }
        return sandbox;
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        if (job.approval && createAttempted && !created) throw new ModalJobError("LAUNCH_UNCERTAIN", "Remote creation was not confirmed. No automatic retry; the full approved sandbox estimate is counted against the project budget conservatively. A remote resource may remain until its timeout.", 502, false);
        if (job.approval && created) throw error; // retain the known id for final cleanup; never launch a fallback
        // A sandbox created just before this failure would keep billing while
        // we move on to the next instance in the chain. Its identity is also
        // cleared so a later successful attempt reconciles against its own
        // creation window rather than this abandoned one.
        if (created) {
          let terminated = false;
          try {
            await created.terminate();
            terminated = true;
          } catch {
            // best effort; the next attempt still needs to proceed, and the id
            // is kept so recovery can retry the termination later
          }
          if (runtime.sandbox === created) runtime.sandbox = undefined;
          const orphanId = created.id;
          this.store.update(projectId, jobId, (current) => {
            current.sandboxId = undefined;
            current.sandboxCreatedAt = undefined;
            current.sandboxTerminatedAt = undefined;
            if (!terminated) current.orphanedSandboxIds = [...(current.orphanedSandboxIds ?? []), orphanId];
          });
        }
        // Only resource availability justifies trying the next instance. A
        // rejected credential or a broken image fails identically everywhere,
        // and cycling the chain would misreport it as "instance unavailable"
        // (and, for an image, rebuild it once per fallback).
        if (NON_FALLBACK_ERROR_CODES.has(errorInfo(error).code)) throw error;
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

  /**
   * Append the remote log bytes not yet retained locally. The wrapper keeps a
   * bounded file plus a `.meta` sidecar with the logical offset of its first
   * retained byte, so the delta is plain arithmetic on byte counts — no
   * suffix/prefix overlap search, and no read at all when nothing changed.
   * Recovery after a restart takes the same path: `stdoutBytes` is the logical
   * count already retained, whatever process retained it.
   */
  private async syncRemoteLogs(
    projectId: string,
    jobId: string,
    sandbox: ModalRemoteSandbox,
    runtime: ActiveRuntime,
  ): Promise<void> {
    runtime.logMeta ??= {};
    for (const stream of ["stdout", "stderr"] as const) {
      const remotePath = stream === "stdout" ? REMOTE_STDOUT : REMOTE_STDERR;
      const checked = this.checked(projectId, jobId, sandbox);
      let size: number;
      try {
        size = (await checked(sandbox.filesystem.stat(remotePath))).size;
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        continue; // not created yet
      }
      let meta: RemoteLogMeta = {};
      try {
        meta = JSON.parse(await checked(sandbox.filesystem.readText(`${remotePath}.meta`))) as RemoteLogMeta;
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        // No sidecar yet (wrapper still starting): treat as nothing dropped.
      }
      if (typeof meta.size === "number" && meta.size !== size) continue; // wrapper mid-write; next tick
      const dropped = typeof meta.dropped === "number" && meta.dropped >= 0 ? meta.dropped : 0;
      const last = runtime.logMeta[stream];
      if (last && last.size === size && last.dropped === dropped) continue; // unchanged
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await checked(sandbox.filesystem.readBytes(remotePath)));
      } catch (error) {
        if (error instanceof ModalCancellationError) throw error;
        continue;
      }
      if (bytes.length !== size) continue; // changed underneath us; next tick
      runtime.logMeta[stream] = { size, dropped };
      const job = this.store.require(projectId, jobId);
      const localTotal = stream === "stdout" ? job.stdoutBytes : job.stderrBytes;
      const remoteTotal = dropped + bytes.length;
      if (localTotal < dropped) {
        // Bytes rolled out of the remote window before we ever saw them.
        this.store.appendEvent(projectId, jobId, {
          type: "log_gap",
          state: job.state,
          message: `${dropped - localTotal} ${stream} bytes were dropped remotely before they could be retained`,
          data: { stream, bytes: dropped - localTotal },
        });
      }
      if (remoteTotal > localTotal) {
        this.store.appendLog(projectId, jobId, stream, bytes.subarray(Math.max(0, localTotal - dropped)));
      }
    }
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
      ...(job.approval ? { maxFiles: 1, maxBytes: 64 * 1024 } : {}),
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
      const initial = this.assertNotCancelled(projectId, jobId);
      assertApprovedJob(initial);
      const pinnedInputs = initial.approval ? await approvedInputPlan(initial) : undefined;
      this.assertNotCancelled(projectId, jobId);
      this.store.transition(projectId, jobId, "preparing");
      sandbox = await this.createSandbox(projectId, jobId, runtime, adapter);
      const checked = this.checked(projectId, jobId, sandbox);
      const job = this.store.require(projectId, jobId);
      const inputPlan = pinnedInputs ?? planInputs(resolvePaths(projectId).sandbox, job.request.filesIn ?? []);
      this.store.update(projectId, jobId, (current) => {
        current.inputFiles = inputPlan.manifest;
      });
      await stageInputs(sandbox, inputPlan, checked);
      if (job.approval) {
        // Hash the bytes actually uploaded, not merely the local snapshot that
        // preceded a potentially racing upload. Mismatch fails before science.
        const verify = `import hashlib,json,sys\nfiles=json.loads(sys.argv[1])\nfor f in files:\n h=hashlib.sha256()\n with open('/workspace/'+f['path'],'rb') as r:\n  for chunk in iter(lambda:r.read(1048576),b''): h.update(chunk)\n if h.hexdigest()!=f['sha256']: raise RuntimeError('Approved input checksum mismatch: '+f['path'])\n`;
        const check = await checked(sandbox.exec(["python3", "-I", "-c", verify, JSON.stringify(job.approval.inputs)], { stdout: "ignore", stderr: "ignore" }));
        if (await checked(check.wait()) !== 0) throw new ModalJobError("INPUT_CHANGED", "Uploaded inputs do not match the approved snapshot", 409);
      }
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
      const lifetimeDeadline =
        (this.store.require(projectId, jobId).sandboxCreatedAt ?? Date.now()) +
        sandboxLifetimeSec(job.request.timeoutSec) * 1000 +
        30_000;
      while (!settled) {
        await checked(sleep(500));
        await this.syncRemoteLogs(projectId, jobId, sandbox, runtime);
        // Modal enforces the lifetime remotely; this local backstop covers an
        // SDK wait() that never settles (network partition, client bug) so the
        // job cannot sit in `running` with its hold forever.
        if (Date.now() > lifetimeDeadline) {
          throw new ModalJobError("TIMEOUT", "Modal sandbox exceeded its lifetime without reporting completion", 504, true);
        }
      }
      await checked(waiter);
      await this.syncRemoteLogs(projectId, jobId, sandbox, runtime);
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
      const cancelled = this.store.require(projectId, jobId).cancelRequested;
      if (error instanceof ModalJobError && error.code === "LAUNCH_UNCERTAIN") {
        await this.finish(projectId, jobId, cancelled ? "cancelled" : "failed", error);
      } else if (error instanceof ModalCancellationError || cancelled) {
        await this.finish(projectId, jobId, "cancelled", new ModalCancellationError());
      } else {
        await this.finish(projectId, jobId, "failed", error);
      }
    } finally {
      // createSandbox can throw *after* creating and persisting a sandbox (a
      // cancel racing creation), so the local binding is not the source of
      // truth for whether one exists.
      const created = sandbox ?? runtime.sandbox;
      if (created) await this.terminateAndRecord(projectId, jobId, created);
      if (this.store.read(projectId, jobId)?.orphanedSandboxIds?.length) {
        await this.terminateOrphans(projectId, jobId, runtime, false);
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
    this.store.resyncLogCounters(projectId, jobId);
    const existing = this.store.require(projectId, jobId);
    if (isTerminalModalState(existing.state)) {
      await this.reconcile(projectId, jobId);
      return;
    }
    if (!existing.sandboxId && existing.approval && existing.state !== "queued") {
      await this.finish(projectId, jobId, "lost", new ModalJobError("LAUNCH_UNCERTAIN", "Restart interrupted a possible remote launch; no automatic re-execution. Full approved estimate counted against the project budget conservatively.", 502));
      return;
    }
    if (!existing.sandboxId) {
      if (existing.state === "preparing") {
        // The crash may have landed between Modal creating the sandbox and us
        // persisting its id. The sandbox carries our job id as a tag, so look
        // for it and terminate it: it never received the wrapper, so it cannot
        // be reattached, only stopped before it bills until its timeout.
        await this.terminateOrphans(projectId, jobId, runtime, true);
      }
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
        await this.terminateAndRecord(projectId, jobId, sandbox);
        throw new ModalCancellationError();
      }
    } catch (error) {
      if (existing.approval && !(error instanceof ModalCancellationError)) this.store.update(projectId, jobId, (j) => { j.approvalCleanupUncertain = true; });
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
        await this.syncRemoteLogs(projectId, jobId, sandbox, runtime);
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
        const deadline =
          (job.sandboxCreatedAt ?? job.createdAt) + sandboxLifetimeSec(job.request.timeoutSec) * 1000;
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
      await this.terminateAndRecord(projectId, jobId, sandbox);
      await this.reconcile(projectId, jobId);
    }
  }

  /**
   * Best-effort termination of sandboxes this job created but could not
   * confirm terminated: ids recorded in `orphanedSandboxIds`, and (when
   * `searchByTag`) any live sandbox tagged with this job id that was never
   * persisted because the process died right after creation.
   */
  private async terminateOrphans(
    projectId: string,
    jobId: string,
    runtime: ActiveRuntime | undefined,
    searchByTag: boolean,
  ): Promise<void> {
    const job = this.store.read(projectId, jobId);
    if (!job) return;
    let adapter = runtime?.adapter;
    let ownAdapter = false;
    try {
      if (!adapter) {
        adapter = this.adapterFactory();
        ownAdapter = true;
      }
      const remaining: string[] = [];
      for (const id of job.orphanedSandboxIds ?? []) {
        try {
          await (await adapter.fromId(id)).terminate();
        } catch (error) {
          if (errorInfo(error).code === "REMOTE_NOT_FOUND") continue; // already gone
          remaining.push(id);
        }
      }
      if (searchByTag && !job.sandboxId) {
        try {
          const found = await adapter.findByTags({ kady: "true", project: projectId, job: jobId });
          if (found) {
            try {
              await found.terminate();
              this.store.appendEvent(projectId, jobId, {
                type: "orphan_terminated",
                state: job.state,
                message: `Terminated sandbox ${found.id} created before the previous shutdown`,
                data: { sandboxId: found.id },
              });
            } catch {
              remaining.push(found.id);
            }
          }
        } catch (error) {
          console.warn("[modal] orphan lookup failed", jobId, error);
        }
      }
      if ((job.orphanedSandboxIds?.length ?? 0) !== remaining.length || remaining.length) {
        this.store.update(projectId, jobId, (current) => {
          current.orphanedSandboxIds = remaining.length ? remaining : undefined;
        });
      }
    } catch (error) {
      console.warn("[modal] orphan cleanup skipped", jobId, error);
    } finally {
      if (ownAdapter) adapter?.close();
    }
  }

  private async terminateAndRecord(projectId: string, jobId: string, sandbox: ModalRemoteSandbox): Promise<void> {
    const current = this.store.require(projectId, jobId);
    if (current.approval && current.sandboxTerminatedAt) return;
    let confirmed = false;
    try { await sandbox.terminate(); confirmed = true; } catch { /* timeout remains the backstop */ }
    this.store.update(projectId, jobId, (job) => {
      if (confirmed || !job.approval) {
        job.sandboxTerminatedAt ??= Date.now();
        if (confirmed) job.approvalCleanupUncertain = undefined;
      } else job.approvalCleanupUncertain = true;
    });
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
    for (const listener of this.terminalListeners) {
      try { listener(this.store.require(projectId, jobId)); } catch (err) { console.warn("[modal] terminal observer failed", err); }
    }
    if (!current.sandboxCreatedAt) await this.reconcile(projectId, jobId);
  }

  private async reconcile(projectId: string, jobId: string): Promise<void> {
    const job = this.store.require(projectId, jobId);
    if (job.accounting.reconciled || !isTerminalModalState(job.state)) return;
    let costUsd = 0;
    let entryId: string | undefined;
    if (job.sandboxCreatedAt && job.pricePerHour !== undefined && !job.approvalCleanupUncertain) {
      const endedAt = job.sandboxTerminatedAt ?? job.finishedAt ?? Date.now();
      // Modal enforces the sandbox lifetime (timeout + transfer headroom) as
      // its maximum age. Cap local observation lag (for example, a slow
      // terminate RPC) so reconciliation cannot exceed the worst-case hold.
      const elapsedMs = Math.min(
        sandboxLifetimeSec(job.request.timeoutSec) * 1000,
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
    if (job.approval && ((!job.sandboxCreatedAt && job.error?.code === "LAUNCH_UNCERTAIN") || job.approvalCleanupUncertain)) {
      costUsd = job.reservationUsd;
      entryId = recordModalJobCost({ projectId, sessionId: job.owner.sessionId, jobId, costUsd, model: `modal:${job.request.instance}`, terminalState: job.state })?.entryId;
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
    const protectedHolds = protectedApprovalReservations(projectId);
    // A process crash in the tiny interval between reservation creation and
    // atomic job creation can leave an orphan hold. No remote resource could
    // have been created at that point, so startup recovery safely releases it.
    for (const reservation of listComputeReservations(projectId)) {
      if (!jobIds.has(reservation.id) && protectedHolds !== null && !protectedHolds.has(reservation.id)) {
        releaseComputeReservation(projectId, reservation.id);
      }
    }
    for (const job of jobs) {
      if (job.approval && !isTerminalModalState(job.state)) {
        if (batchCancelled(projectId, job.approval.batchId)) { await this.cancel(projectId, job.id); continue; }
        if (!batchCommitted(projectId, job.approval.batchId)) continue; // held for admission recovery
        try { assertApprovedJob(job); }
        catch (e) { await this.finish(projectId, job.id, "failed", e); continue; }
      }
      if (isTerminalModalState(job.state)) {
        // A crash between finish() and terminateAndRecord() — or a cancel that
        // ran while credentials were missing — leaves a terminal record whose
        // sandbox may still be alive and billing. Any job, not only approved.
        if (job.sandboxId && !job.sandboxTerminatedAt && !(this.requireCredentials && !modalConfigured())) {
          const adapter = this.adapterFactory();
          try { await this.terminateAndRecord(projectId, job.id, await adapter.fromId(job.sandboxId)); }
          catch (error) {
            if (errorInfo(error).code === "REMOTE_NOT_FOUND") {
              this.store.update(projectId, job.id, (j) => { j.sandboxTerminatedAt ??= Date.now(); });
            } else if (job.approval) {
              this.store.update(projectId, job.id, (j) => { j.approvalCleanupUncertain = true; });
            }
          }
          finally { adapter.close(); }
        }
        if (job.orphanedSandboxIds?.length && !(this.requireCredentials && !modalConfigured())) {
          await this.terminateOrphans(projectId, job.id, undefined, false);
        }
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
