"use client";

import type { ActivityItem } from "@/lib/use-agent";

export const MODAL_CREDENTIALS_CHANGED_EVENT = "kady:credentials-changed";
export const MODAL_JOBS_CHANGED_EVENT = "kady:modal-jobs-changed";
export const MODAL_JOB_FINISHED_EVENT = "kady:modal-job-finished";
export const OPEN_MODAL_JOB_EVENT = "kady:open-modal-job";

export const MODAL_JOB_STATUSES = [
  "queued",
  "preparing",
  "running",
  "collecting",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;

export type ModalJobStatus = (typeof MODAL_JOB_STATUSES)[number];
export type ModalLogStream = "stdout" | "stderr";
export type ModalComputeScope = "project" | "session";

const STATUS_SET = new Set<string>(MODAL_JOB_STATUSES);
const ACTIVE_STATUS_SET = new Set<ModalJobStatus>([
  "queued",
  "preparing",
  "running",
  "collecting",
]);

export interface ModalInstance {
  id: string;
  label: string;
  gpu: string | null;
  gpuCount: number;
  maxGpuCount?: number;
  cpu: number | null;
  memoryMiB: number | null;
  pricePerHour: number;
  defaultImage?: string;
  vramGiB?: number | null;
  tier?: string;
  description?: string;
  bestFor?: string;
  fallback?: string | null;
  cache?: string | null;
  kind?: "cpu" | "gpu";
  legacy?: boolean;
  raw?: Record<string, unknown>;
}

export interface ModalCatalogDefaults {
  instanceId: string | null;
  gpuCount: number;
  fallback: string | null;
  cache: string | null;
  raw: Record<string, unknown>;
}

export interface ModalCatalog {
  modalConfigured: boolean;
  instances: ModalInstance[];
  defaults: ModalCatalogDefaults;
}

export interface ModalJobResource {
  instanceId: string | null;
  label: string | null;
  gpu: string | null;
  gpuCount: number;
  cpu: number | null;
  memoryMiB: number | null;
  pricePerHour: number | null;
  timeoutSeconds: number | null;
  image: string | null;
  fallback: string | null;
  cache: string | null;
  raw: Record<string, unknown>;
}

export interface ModalTransferEntry {
  path: string;
  localPath: string | null;
  remotePath: string | null;
  bytes: number | null;
  checksum: string | null;
  status: string | null;
  error: string | null;
  required: boolean | null;
  raw: Record<string, unknown>;
}

export interface ModalArtifact {
  path: string;
  bytes: number | null;
  checksum: string | null;
  status: string | null;
  error: string | null;
}

export interface ModalJobSummary {
  id: string;
  groupId: string | null;
  sessionId: string | null;
  source: string | null;
  agent: string | null;
  status: ModalJobStatus;
  command: string | null;
  requestedResource: ModalJobResource | null;
  resolvedResource: ModalJobResource | null;
  createdAt: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  exitCode: number | null;
  error: string | null;
  spentEstimatedUsd: number;
  reservedEstimatedUsd: number;
  committedEstimatedUsd: number;
  inputTransfers: ModalTransferEntry[];
  outputTransfers: ModalTransferEntry[];
  artifacts: ModalArtifact[];
  retryOf: string | null;
  raw: Record<string, unknown>;
}

export type ModalJobDetail = ModalJobSummary;

export interface ModalJobGroup {
  id: string;
  label: string | null;
  status: ModalJobStatus | null;
  jobIds: string[];
  createdAt: string | null;
  raw: Record<string, unknown>;
}

export interface ModalJobsResponse {
  jobs: ModalJobSummary[];
  groups: ModalJobGroup[];
}

export interface ModalLogDelta {
  stream: ModalLogStream;
  after: number;
  cursor: number;
  delta: string;
  truncated: boolean;
  complete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function timestampValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      if (/^\d+(?:\.\d+)?$/.test(value)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          return new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString();
        }
      }
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function booleanValue(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function recordValue(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item];
    if (!isRecord(item)) return [];
    const id = stringValue(item.id, item.jobId, item.job_id);
    return id ? [id] : [];
  });
}

function statusValue(value: unknown, fallback: ModalJobStatus = "lost"): ModalJobStatus {
  return typeof value === "string" && STATUS_SET.has(value)
    ? (value as ModalJobStatus)
    : fallback;
}

function costValue(
  job: Record<string, unknown>,
  costs: Record<string, unknown>,
  kind: "spent" | "reserved" | "committed",
): number {
  const capitalized = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return Math.max(
    0,
    numberValue(
      job[`${kind}EstimatedUsd`],
      job[`estimated${capitalized}Usd`],
      job[`${kind}Usd`],
      costs[`${kind}EstimatedUsd`],
      costs[`estimated${capitalized}Usd`],
      costs[`${kind}Usd`],
      costs[kind],
    ) ?? 0,
  );
}

export function parseModalInstance(value: unknown): ModalInstance | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id, value.instanceId, value.instance_id);
  if (!id) return null;
  const gpu = stringValue(value.gpu, value.modalGpu, value.gpuType, value.gpu_type);
  const gpuCount = Math.max(
    1,
    Math.floor(numberValue(value.gpuCount, value.gpu_count, value.count) ?? 1),
  );
  return {
    id,
    label: stringValue(value.label, value.name) ?? id,
    gpu,
    gpuCount,
    maxGpuCount: Math.max(
      gpuCount,
      Math.floor(numberValue(value.maxGpuCount, value.max_gpu_count) ?? gpuCount),
    ),
    cpu: numberValue(value.cpu, value.cpus, value.cpuCores, value.cpu_cores),
    memoryMiB: numberValue(
      value.memoryMiB,
      value.memory_mib,
      value.memory,
      value.memoryMb,
    ),
    pricePerHour: Math.max(
      0,
      numberValue(value.pricePerHour, value.price_per_hour, value.hourlyRate) ?? 0,
    ),
    ...(stringValue(value.defaultImage, value.default_image)
      ? { defaultImage: stringValue(value.defaultImage, value.default_image)! }
      : {}),
    vramGiB: numberValue(value.vramGiB, value.vram, value.vram_gib),
    ...(stringValue(value.tier) ? { tier: stringValue(value.tier)! } : {}),
    ...(stringValue(value.description)
      ? { description: stringValue(value.description)! }
      : {}),
    ...(stringValue(value.bestFor, value.best_for)
      ? { bestFor: stringValue(value.bestFor, value.best_for)! }
      : {}),
    fallback: stringValue(value.fallback, value.fallbackId, value.fallback_id),
    cache: stringValue(value.cache, value.cacheName, value.cache_name),
    kind:
      value.kind === "cpu" || value.kind === "gpu"
        ? value.kind
        : gpu
          ? "gpu"
          : "cpu",
    legacy: booleanValue(value.legacy) ?? false,
    raw: value,
  };
}

export function parseModalCatalog(value: unknown): ModalCatalog {
  const root = isRecord(value) ? value : {};
  const defaults = recordValue(root.defaults);
  const instances = (Array.isArray(root.instances) ? root.instances : [])
    .map(parseModalInstance)
    .filter((item): item is ModalInstance => item !== null);
  return {
    modalConfigured: booleanValue(
      root.modalConfigured,
      root.modal_configured,
      root.configured,
    ) ?? false,
    instances,
    defaults: {
      instanceId: stringValue(
        defaults.instanceId,
        defaults.instance_id,
        defaults.instance,
        root.defaultInstanceId,
      ),
      gpuCount: Math.max(
        1,
        Math.floor(numberValue(defaults.gpuCount, defaults.gpu_count) ?? 1),
      ),
      fallback: stringValue(
        defaults.fallback,
        defaults.fallbackId,
        defaults.fallback_id,
      ),
      cache: stringValue(defaults.cache, defaults.cacheName, defaults.cache_name),
      raw: defaults,
    },
  };
}

export function parseModalJobResource(value: unknown): ModalJobResource | null {
  if (typeof value === "string" && value.trim()) {
    return {
      instanceId: value,
      label: value,
      gpu: null,
      gpuCount: 1,
      cpu: null,
      memoryMiB: null,
      pricePerHour: null,
      timeoutSeconds: null,
      image: null,
      fallback: null,
      cache: null,
      raw: { instanceId: value },
    };
  }
  if (!isRecord(value)) return null;
  const explicitInstanceId = stringValue(value.instanceId, value.instance_id, value.id);
  const instanceId = explicitInstanceId ?? stringValue(value.instance);
  const gpu = stringValue(value.gpu, value.gpuType, value.gpu_type, value.modalGpu);
  const fallbackValues = value.gpuFallback ?? value.gpu_fallback;
  return {
    instanceId,
    // A job request also has a user-facing `label`; it names the job, not its
    // compute resource. Only resource-shaped objects may use that field.
    label:
      stringValue(value.resourceLabel, value.resource_label) ??
      (explicitInstanceId ? stringValue(value.label, value.name) : null) ??
      instanceId,
    gpu,
    gpuCount: Math.max(
      1,
      Math.floor(numberValue(value.gpuCount, value.gpu_count, value.count) ?? 1),
    ),
    cpu: numberValue(value.cpu, value.cpus, value.cpuCores, value.cpu_cores),
    memoryMiB: numberValue(value.memoryMiB, value.memory_mib, value.memory),
    pricePerHour: numberValue(
      value.pricePerHour,
      value.price_per_hour,
      value.hourlyRate,
    ),
    timeoutSeconds: numberValue(
      value.timeoutSeconds,
      value.timeout_seconds,
      value.timeoutSec,
      value.timeout_sec,
      value.timeout,
    ),
    image: stringValue(
      value.image,
      value.baseImage,
      value.base_image,
      isRecord(value.image) ? value.image.base : null,
    ),
    fallback:
      stringValue(value.fallback, value.fallbackId, value.fallback_id) ??
      (Array.isArray(fallbackValues)
        ? fallbackValues.filter((item): item is string => typeof item === "string").join(" → ") || null
        : null),
    cache: stringValue(value.cache, value.cacheName, value.cache_name),
    raw: value,
  };
}

function parseTransfer(value: unknown): ModalTransferEntry | null {
  if (typeof value === "string" && value.trim()) {
    return {
      path: value,
      localPath: value,
      remotePath: null,
      bytes: null,
      checksum: null,
      status: null,
      error: null,
      required: null,
      raw: { path: value },
    };
  }
  if (!isRecord(value)) return null;
  const localPath = stringValue(
    value.localPath,
    value.local_path,
    value.destination,
    value.dest,
  );
  const remotePath = stringValue(value.remotePath, value.remote_path, value.source);
  const path = stringValue(value.path, value.relativePath, value.relative_path, localPath, remotePath);
  if (!path) return null;
  return {
    path,
    localPath,
    remotePath,
    bytes: numberValue(value.bytes, value.size, value.sizeBytes, value.size_bytes),
    checksum: stringValue(value.checksum, value.sha256, value.hash),
    status: stringValue(value.status, value.state),
    error: stringValue(value.error, value.detail, value.message),
    required: booleanValue(value.required),
    raw: value,
  };
}

function parseTransfers(value: unknown): ModalTransferEntry[] {
  return (Array.isArray(value) ? value : [])
    .map(parseTransfer)
    .filter((entry): entry is ModalTransferEntry => entry !== null);
}

function parseArtifacts(value: unknown): ModalArtifact[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const parsed = parseTransfer(item);
    if (!parsed) return [];
    return [{
      path: parsed.localPath ?? parsed.path,
      bytes: parsed.bytes,
      checksum: parsed.checksum,
      status: parsed.status,
      error: parsed.error,
    }];
  });
}

export function parseModalJob(value: unknown): ModalJobSummary | null {
  const wrapped = isRecord(value) && isRecord(value.job) ? value.job : value;
  if (!isRecord(wrapped)) return null;
  const id = stringValue(wrapped.id, wrapped.jobId, wrapped.job_id);
  if (!id) return null;
  const timestamps = recordValue(wrapped.timestamps);
  const costs = recordValue(wrapped.costs, wrapped.estimatedCosts, wrapped.estimated_costs);
  const request = recordValue(wrapped.request, wrapped.requested);
  const owner = recordValue(wrapped.owner);
  const accounting = recordValue(wrapped.accounting);
  const transfers = recordValue(wrapped.transfers, wrapped.transferManifest);
  const inputTransfers = parseTransfers(
    wrapped.inputTransfers ??
      wrapped.inputs ??
      wrapped.inputFiles ??
      wrapped.inputManifest ??
      transfers.inputs ??
      transfers.input,
  );
  const outputTransfers = parseTransfers(
    wrapped.outputTransfers ??
      wrapped.outputs ??
      wrapped.outputFiles ??
      wrapped.outputManifest ??
      transfers.outputs ??
      transfers.output,
  );
  const status = statusValue(wrapped.status ?? wrapped.state);
  const spentEstimatedUsd =
    costValue(wrapped, costs, "spent") ||
    Math.max(0, numberValue(accounting.estimatedCostUsd, accounting.estimated_cost_usd) ?? 0);
  const reservedEstimatedUsd =
    costValue(wrapped, costs, "reserved") ||
    (isModalJobActive(status)
      ? Math.max(0, numberValue(wrapped.reservationUsd, wrapped.reservation_usd) ?? 0)
      : 0);
  const explicitCommitted = costValue(wrapped, costs, "committed");
  const artifacts = parseArtifacts(
    wrapped.artifacts ??
      wrapped.results ??
      wrapped.outputArtifacts ??
      wrapped.outputFiles,
  );
  const missingOutputs = Array.isArray(wrapped.missingOutputs)
    ? wrapped.missingOutputs.filter((item): item is string => typeof item === "string")
    : [];
  for (const path of missingOutputs) {
    outputTransfers.push({
      path,
      localPath: path,
      remotePath: null,
      bytes: null,
      checksum: null,
      status: "missing",
      error: "Expected output was not found",
      required: true,
      raw: { path, status: "missing" },
    });
  }
  const inferredArtifacts =
    artifacts.length > 0
      ? artifacts
      : outputTransfers
          .filter((entry) => !entry.error && entry.localPath)
          .map((entry) => ({
            path: entry.localPath!,
            bytes: entry.bytes,
            checksum: entry.checksum,
            status: entry.status,
            error: entry.error,
          }));
  return {
    id,
    groupId: stringValue(
      wrapped.groupId,
      wrapped.group_id,
      wrapped.batchId,
      wrapped.batch_id,
      request.groupId,
      request.group_id,
    ),
    sessionId: stringValue(wrapped.sessionId, wrapped.session_id, owner.sessionId, owner.session_id),
    source: stringValue(
      wrapped.source,
      wrapped.tool,
      wrapped.toolName,
      wrapped.tool_name,
      owner.submittedBy,
      owner.submitted_by,
    ),
    agent:
      stringValue(wrapped.agent, wrapped.agentName, wrapped.agent_name) ??
      (stringValue(owner.subagentRunId, owner.subagent_run_id)
        ? `subagent ${stringValue(owner.subagentRunId, owner.subagent_run_id)}`
        : null),
    status,
    command: stringValue(wrapped.command, wrapped.script, request.command),
    requestedResource: parseModalJobResource(
      wrapped.requestedResource ??
        wrapped.requested_resource ??
        wrapped.requested ??
        request,
    ),
    resolvedResource: parseModalJobResource(
      wrapped.resolvedResource ??
        wrapped.resolved_resource ??
        wrapped.resolved ??
        (wrapped.effectiveInstance || wrapped.effectiveGpu
          ? {
              instanceId: wrapped.effectiveInstance,
              gpu: wrapped.effectiveGpu,
              gpuCount: request.gpuCount,
              pricePerHour: wrapped.pricePerHour,
              cpu: request.cpu,
              memoryMiB: request.memoryMiB,
            }
          : null),
    ),
    createdAt: timestampValue(wrapped.createdAt, wrapped.created_at, timestamps.created),
    queuedAt: timestampValue(wrapped.queuedAt, wrapped.queued_at, timestamps.queued),
    startedAt: timestampValue(
      wrapped.startedAt,
      wrapped.started_at,
      wrapped.runningAt,
      wrapped.running_at,
      timestamps.started,
      timestamps.running,
    ),
    finishedAt: timestampValue(
      wrapped.finishedAt,
      wrapped.finished_at,
      wrapped.completedAt,
      wrapped.completed_at,
      timestamps.finished,
      timestamps.completed,
    ),
    updatedAt: timestampValue(wrapped.updatedAt, wrapped.updated_at, timestamps.updated),
    exitCode: numberValue(wrapped.exitCode, wrapped.exit_code),
    error: stringValue(
      wrapped.error,
      wrapped.errorMessage,
      wrapped.error_message,
      wrapped.failure,
      wrapped.detail,
      isRecord(wrapped.error) ? wrapped.error.message : null,
      isRecord(wrapped.failure) ? wrapped.failure.message : null,
    ),
    spentEstimatedUsd,
    reservedEstimatedUsd,
    committedEstimatedUsd:
      explicitCommitted || spentEstimatedUsd + reservedEstimatedUsd,
    inputTransfers,
    outputTransfers,
    artifacts: inferredArtifacts,
    retryOf: stringValue(wrapped.retryOf, wrapped.retry_of),
    raw: wrapped,
  };
}

function parseModalJobGroup(value: unknown): ModalJobGroup | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id, value.groupId, value.group_id, value.batchId, value.batch_id);
  if (!id) return null;
  const status =
    typeof value.status === "string" && STATUS_SET.has(value.status)
      ? (value.status as ModalJobStatus)
      : null;
  return {
    id,
    label: stringValue(value.label, value.name),
    status,
    jobIds: stringArray(value.jobIds ?? value.job_ids ?? value.jobs),
    createdAt: stringValue(value.createdAt, value.created_at),
    raw: value,
  };
}

export function parseModalJobsResponse(value: unknown): ModalJobsResponse {
  const root = isRecord(value) ? value : {};
  const jobValues = Array.isArray(value)
    ? value
    : Array.isArray(root.jobs)
      ? root.jobs
      : Array.isArray(root.items)
        ? root.items
        : [];
  const jobs = jobValues
    .map(parseModalJob)
    .filter((job): job is ModalJobSummary => job !== null);
  const groups = recordArray(root.groups)
    .map(parseModalJobGroup)
    .filter((group): group is ModalJobGroup => group !== null);
  return { jobs, groups };
}

export function parseModalLogDelta(
  value: unknown,
  stream: ModalLogStream,
  after: number,
): ModalLogDelta {
  const root = isRecord(value) ? value : {};
  const delta = stringValue(root.delta, root.content, root.text, root.data) ?? "";
  const cursor = Math.max(
    after,
    Math.floor(
      numberValue(
        root.nextCursor,
        root.next_cursor,
        root.cursor,
        root.offset,
        root.after,
      ) ?? after + new TextEncoder().encode(delta).byteLength,
    ),
  );
  return {
    stream:
      root.stream === "stderr" || root.stream === "stdout"
        ? root.stream
        : stream,
    after,
    cursor,
    delta,
    truncated: booleanValue(root.truncated, root.reset) ?? false,
    complete: booleanValue(root.complete, root.done, root.eof) ?? false,
  };
}

export function isModalJobActive(status: ModalJobStatus): boolean {
  return ACTIVE_STATUS_SET.has(status);
}

export function isModalJobTerminal(status: ModalJobStatus): boolean {
  return !isModalJobActive(status);
}

export function modalStatusLabel(status: ModalJobStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatModalBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatModalDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  now = Date.now(),
): string {
  if (!startedAt) return "Not started";
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return "—";
  const seconds = Math.max(0, Math.floor((finish - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatModalTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatModalResource(resource: ModalJobResource | null): string {
  if (!resource) return "—";
  const name =
    resource.label && resource.label !== resource.instanceId
      ? resource.label
      : resource.gpu ?? resource.instanceId ?? "Custom";
  if (resource.gpu) {
    return `${resource.gpuCount > 1 ? `${resource.gpuCount}× ` : ""}${name}`;
  }
  return resource.cpu ? `${name} · ${resource.cpu} CPU` : name;
}

export function modalJobIdFromActivity(item: Pick<ActivityItem, "args" | "result">): string | null {
  if (isRecord(item.args)) {
    const direct = stringValue(
      item.args.jobId,
      item.args.job_id,
      item.args.id,
    );
    if (direct) return direct;
  }
  if (!item.result) return null;
  try {
    const parsed = JSON.parse(item.result) as unknown;
    if (isRecord(parsed)) {
      const direct = stringValue(
        parsed.jobId,
        parsed.job_id,
        parsed.id,
        isRecord(parsed.job) ? parsed.job.id : null,
      );
      if (direct) return direct;
    }
  } catch {
    // Tool results are commonly prose rather than JSON.
  }
  const match = item.result.match(
    /(?:job(?:\s+id)?|jobId|job_id)\s*(?:is|[:=])?\s*[`"']?([a-zA-Z0-9][a-zA-Z0-9_-]{3,})/i,
  );
  return match?.[1] ?? null;
}

export function notifyModalCredentialsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MODAL_CREDENTIALS_CHANGED_EVENT, {
      detail: { provider: "modal" },
    }),
  );
}

export function openModalJob(jobId?: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_MODAL_JOB_EVENT, {
      detail: jobId ? { jobId } : {},
    }),
  );
}
