import { Type, type Static } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  trackSubagentChildIdentity,
  type SubagentChildIdentity,
} from "../../src/agent/subagent-child-identity.ts";
import { modalProjectId } from "./project-id.ts";

const INSTANCE_IDS = [
  "cpu", "cpu-2", "cpu-4", "cpu-8", "cpu-16", "t4", "l4", "a10g",
  "l40s", "a100-40gb", "a100-80gb", "h100", "h200", "b200",
];

const ModalImageParams = Type.Object({
  base: Type.Optional(
    Type.String({
      description: "Base registry image (default python:3.13-slim).",
    }),
  ),
  pip: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
  apt: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
});

/** Deliberately mirrors server/src/agent/modal-tool.ts; parity is tested. */
export const ModalRunParams = Type.Object({
  command: Type.String({
    description: "Shell command to run remotely via `sh` in /workspace.",
  }),
  instance: Type.Optional(
    Type.String({
      description: `Compute instance id (${INSTANCE_IDS.join(", ")}). Omit for the chat default or "cpu".`,
    }),
  ),
  gpu_count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description: "Number of GPUs. CPU presets require 1; A10 supports up to 4; other GPUs up to 8.",
    }),
  ),
  gpu_fallback: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 7,
      description: "Ordered fallback instance ids if the preferred instance cannot be allocated.",
    }),
  ),
  image: Type.Optional(ModalImageParams),
  environment: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      description:
        "Optional named reusable environment. The normalized image is built and published for reuse.",
    }),
  ),
  cache: Type.Optional(
    Type.Union([Type.Literal("project"), Type.Literal("none")], {
      description: 'Use the project Modal cache Volume (default) or "none" for an ephemeral job.',
    }),
  ),
  files_in: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 128,
      description: "Required sandbox-relative files/directories to upload. Missing inputs fail before submission.",
    }),
  ),
  files_out: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 128,
      description: "Sandbox-relative output paths or bounded * / ** / ? globs to install atomically.",
    }),
  ),
  timeout_sec: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 86400,
      description: "Command timeout in seconds (default 600). The sandbox lives slightly longer for input/output transfer.",
    }),
  ),
  label: Type.Optional(Type.String({ maxLength: 200 })),
});
type ModalRunParamsT = Static<typeof ModalRunParams>;

export const ModalJobIdParams = Type.Object({
  job_id: Type.String({ description: "Durable Modal job id returned by modal_submit/modal_run." }),
});
export const ModalWaitParams = Type.Object({
  job_id: Type.String(),
  timeout_sec: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 3600,
      description: "How long to wait. Returns the current state if it remains active.",
    }),
  ),
});
export const ModalSubmitBatchParams = Type.Object({
  jobs: Type.Array(ModalRunParams, {
    minItems: 1,
    maxItems: 32,
    description: "Independent jobs submitted under one group id.",
  }),
  group_id: Type.Optional(Type.String()),
});

interface ApiJob {
  id: string;
  state: string;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

/** Shape of `GET /modal/jobs/:id/results` (manager.result()). */
interface ApiJobResult {
  job: ApiJob;
  stdout?: string;
  stderr?: string;
}

/** Shape of `GET /modal/jobs/:id` (job record + event log after a cursor). */
interface ApiJobStatus {
  job: ApiJob;
  events?: { seq?: number }[];
}

interface ApiBatch {
  groupId?: string;
  jobs?: ApiJob[];
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_SEC = 600;

/** Same bound as the lead's modal-tool.ts; both feed the same model context. */
const MAX_TOOL_OUTPUT_CHARS = 16_000;
/** Job records carry up to 10,000-row transfer manifests; the model needs a sample. */
const MAX_LIST_ENTRIES = 50;
const CAPPED_LIST_KEYS = new Set(["inputFiles", "outputFiles", "files_out", "missing_outputs"]);
/** Server-internal fields with no value to the model (approval is server-only). */
const DROPPED_JOB_KEYS = new Set(["sandboxTags", "approval"]);

const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 5_000;
const POLL_BACKOFF = 1.5;
/** Consecutive `fetch failed`-style errors tolerated while the server restarts. */
const MAX_TRANSPORT_ERRORS = 5;

/**
 * A response the Kady API answered with. `code`/`retryable` come from the
 * routes' `fail()` body (`{ error: <code>, detail, retryable? }`) so tools can
 * surface BUDGET_EXCEEDED / NOT_CONFIGURED / JOB_NOT_FOUND instead of a flat
 * MODAL_FAILURE. Distinguishing this from a transport error also lets the wait
 * loop know the server is up (never retry an answered error).
 */
class ApiError extends Error {
  code?: string;
  retryable?: boolean;
  status?: number;

  constructor(message: string, info: { code?: string; retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = info.code;
    this.retryable = info.retryable;
    this.status = info.status;
  }
}

function projectId(): string {
  return modalProjectId();
}

function apiBase(): string {
  return (
    process.env.KADY_INTERNAL_URL ||
    `http://127.0.0.1:${process.env.KADY_PORT || process.env.PORT || "8000"}`
  ).replace(/\/+$/, "");
}

async function api<T>(
  route: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  // Only claim a JSON body when one is sent: Fastify rejects a body-less POST
  // that carries `Content-Type: application/json` with 400
  // FST_ERR_CTP_EMPTY_JSON_BODY, which is what used to break every cancel.
  const headers: Record<string, string> = {
    "X-Project-Id": projectId(),
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const response = await fetch(`${apiBase()}${route}`, { ...init, signal, headers });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const body = (data && typeof data === "object" ? data : {}) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    const code = typeof body.error === "string" ? body.error : undefined;
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.message === "string"
          ? body.message
          : undefined;
    throw new ApiError(detail || code || `Modal API returned HTTP ${response.status}`, {
      code,
      retryable: typeof body.retryable === "boolean" ? body.retryable : undefined,
      status: response.status,
    });
  }
  if (data === undefined) {
    throw new ApiError(`Modal API returned a non-JSON response (HTTP ${response.status})`, {
      status: response.status,
    });
  }
  return data as T;
}

/**
 * Owner fields that let the server re-attribute this child's jobs to the
 * parent chat once the delegation completes (modal-bridge.ts). The run id is
 * only present under a legacy per-process runner; since pi-subagents 0.65 the
 * child's session file is the correlation key the parent receives.
 */
function ownerFields(identity: SubagentChildIdentity) {
  return {
    ...(identity.runId ? { subagent_run_id: identity.runId } : {}),
    ...(identity.sessionFile ? { subagent_session_file: identity.sessionFile } : {}),
  };
}

async function submit(
  params: ModalRunParamsT,
  identity: SubagentChildIdentity,
  groupId?: string,
): Promise<ApiJob> {
  return api<ApiJob>("/modal/jobs", {
    method: "POST",
    body: JSON.stringify({
      ...params,
      ...(groupId ? { group_id: groupId } : {}),
      ...ownerFields(identity),
    }),
  });
}

async function status(jobId: string, signal?: AbortSignal): Promise<ApiJob> {
  const data = await api<ApiJobStatus>(`/modal/jobs/${encodeURIComponent(jobId)}`, {}, signal);
  return data.job;
}

/** Cancel POSTs carry an explicit (empty) JSON body; see `api()`. */
async function cancelJob(jobId: string): Promise<ApiJob> {
  return api<ApiJob>(`/modal/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

async function results(jobId: string): Promise<ApiJobResult> {
  return api<ApiJobResult>(`/modal/jobs/${encodeURIComponent(jobId)}/results`);
}

function terminal(state: string): boolean {
  return ["succeeded", "failed", "cancelled", "lost"].includes(state);
}

function abortError(): ApiError {
  return new ApiError("Wait aborted", { code: "ABORTED" });
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.code === "ABORTED") ||
    (error as { name?: unknown } | null)?.name === "AbortError"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(1, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a job until it is terminal or `timeoutSec` elapses (0 = one read),
 * returning the last observed record. Polling backs off 500 ms → 5 s; the
 * event log is read incrementally via `eventsAfter`; up to
 * MAX_TRANSPORT_ERRORS consecutive connection failures are tolerated (the
 * server may be restarting — the job itself is durable), while an answered
 * error (JOB_NOT_FOUND, …) or an abort throws immediately.
 */
async function waitFor(
  jobId: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<ApiJob> {
  const deadline = Date.now() + timeoutSec * 1000;
  let delay = POLL_INITIAL_MS;
  let lastSeq = 0;
  let transportErrors = 0;
  while (true) {
    if (signal?.aborted) throw abortError();
    let job: ApiJob | undefined;
    try {
      const data = await api<ApiJobStatus>(
        `/modal/jobs/${encodeURIComponent(jobId)}?eventsAfter=${lastSeq}`,
        {},
        signal,
      );
      job = data.job;
      for (const event of data.events ?? []) {
        if (typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
      }
      transportErrors = 0;
    } catch (error) {
      if (signal?.aborted || isAbort(error) || error instanceof ApiError) throw error;
      transportErrors += 1;
      if (transportErrors > MAX_TRANSPORT_ERRORS || Date.now() >= deadline) throw error;
    }
    if (job && (terminal(job.state) || Date.now() >= deadline)) return job;
    await sleep(Math.min(delay, Math.max(1, deadline - Date.now())), signal);
    delay = Math.min(POLL_MAX_MS, delay * POLL_BACKOFF);
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return `…(${value.length - MAX_TOOL_OUTPUT_CHARS} earlier characters truncated)\n${value.slice(-MAX_TOOL_OUTPUT_CHARS)}`;
}

function capList(list: unknown[]): unknown[] {
  if (list.length <= MAX_LIST_ENTRIES) return list;
  return [...list.slice(0, MAX_LIST_ENTRIES), `… ${list.length - MAX_LIST_ENTRIES} more`];
}

/**
 * The job record the model sees. The API returns the full durable `ModalJob`;
 * this drops server-internal fields and caps the transfer manifests so a job
 * with thousands of files cannot flood the child's context. Used for the
 * structured `details` too, which Pi keeps in the tool result.
 */
function summarizeJob(job: ApiJob): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(job)) {
    if (DROPPED_JOB_KEYS.has(key)) continue;
    if (key === "accounting" && value && typeof value === "object" && !Array.isArray(value)) {
      const { ledgerEntryId: _ledgerEntryId, ...rest } = value as Record<string, unknown>;
      out.accounting = rest;
      continue;
    }
    out[key] = CAPPED_LIST_KEYS.has(key) && Array.isArray(value) ? capList(value) : value;
  }
  return out;
}

function summarizeBatch(batch: ApiBatch): Record<string, unknown> {
  return {
    ...batch,
    ...(Array.isArray(batch.jobs) ? { jobs: batch.jobs.map(summarizeJob) } : {}),
  };
}

function jobText(summary: Record<string, unknown>): string {
  return JSON.stringify(summary, null, 2);
}

/** Compact summary plus tail-truncated stdout/stderr, like the lead's tools. */
function renderResults(output: ApiJobResult): { text: string; summary: Record<string, unknown> } {
  const summary = summarizeJob(output.job);
  const text = [
    jobText(summary),
    `--- stdout ---\n${truncate(output.stdout ?? "") || "(empty)"}`,
    `--- stderr ---\n${truncate(output.stderr ?? "") || "(empty)"}`,
  ].join("\n\n");
  return { text, summary };
}

function result(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function failed(error: unknown, extra?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  const code = isAbort(error)
    ? "ABORTED"
    : error instanceof ApiError && error.code
      ? error.code
      : "MODAL_FAILURE";
  const retryable = error instanceof ApiError ? (error.retryable ?? false) : false;
  return result(`Modal compute request failed: ${message}`, {
    ...extra,
    error: code,
    retryable,
  });
}

/**
 * The child tool set. `getIdentity` is read at call time so jobs carry the
 * session the child learned at `session_start`, not module-load state shared
 * with other children hosted in the same runner process.
 */
export function makeModalChildTools(
  getIdentity: () => SubagentChildIdentity = () => ({}),
): ToolDefinition<any>[] {
  return [
    {
      name: "modal_run",
      label: "Modal compute",
      description:
        "Run durable remote Modal CPU/GPU compute, wait, and return logs/results. Aborting cancels this job.",
      parameters: ModalRunParams,
      execute: async (_id, params: ModalRunParamsT, signal?: AbortSignal) => {
        let job: ApiJob | undefined;
        let cancelRequested = false;
        // Fire-and-forget: an abort listener cannot await, and several children
        // share this runner process, so an unhandled rejection here would take
        // the others down with it.
        const cancel = () => {
          if (!job || cancelRequested) return;
          cancelRequested = true;
          cancelJob(job.id).catch((error) =>
            console.warn("[kady-modal] cancel failed", job?.id, error),
          );
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          job = await submit(params, getIdentity());
          if (signal?.aborted) cancel();
          const timeoutSec = params.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
          const waited = await waitFor(job.id, timeoutSec, signal);
          const rendered = renderResults(await results(job.id));
          const stillRunning = !terminal(waited.state)
            ? `Job is still ${waited.state} after ${timeoutSec}s; it continues in the background. Use modal_wait/modal_results with job_id ${job.id}.\n\n`
            : "";
          return result(`${stillRunning}${rendered.text}`, rendered.summary);
        } catch (error) {
          if (signal?.aborted) cancel();
          return failed(error, job ? { job_id: job.id } : undefined);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    },
    {
      name: "modal_submit",
      label: "Submit Modal job",
      description: "Submit durable asynchronous Modal compute. It survives child/chat abort.",
      parameters: ModalRunParams,
      execute: async (_id, params: ModalRunParamsT) => {
        try {
          const summary = summarizeJob(await submit(params, getIdentity()));
          return result(jobText(summary), summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "modal_status",
      label: "Modal job status",
      description: "Read durable Modal job state.",
      parameters: ModalJobIdParams,
      execute: async (_id, params: { job_id: string }) => {
        try {
          const summary = summarizeJob(await status(params.job_id));
          return result(jobText(summary), summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "modal_wait",
      label: "Wait for Modal job",
      description: "Wait for a Modal job or return its current state after timeout.",
      parameters: ModalWaitParams,
      execute: async (
        _id,
        params: { job_id: string; timeout_sec?: number },
        signal?: AbortSignal,
      ) => {
        try {
          const summary = summarizeJob(
            await waitFor(params.job_id, params.timeout_sec ?? DEFAULT_TIMEOUT_SEC, signal),
          );
          return result(jobText(summary), summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "modal_cancel",
      label: "Cancel Modal job",
      description: "Cancel a durable Modal job and terminate its sandbox.",
      parameters: ModalJobIdParams,
      execute: async (_id, params: { job_id: string }) => {
        try {
          const summary = summarizeJob(await cancelJob(params.job_id));
          return result(jobText(summary), summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "modal_results",
      label: "Modal job results",
      description: "Read retained logs and installed output metadata.",
      parameters: ModalJobIdParams,
      execute: async (_id, params: { job_id: string }) => {
        try {
          const rendered = renderResults(await results(params.job_id));
          return result(rendered.text, rendered.summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "modal_submit_batch",
      label: "Submit Modal batch",
      description: "Submit up to 32 independent durable Modal jobs as one group.",
      parameters: ModalSubmitBatchParams,
      execute: async (
        _id,
        params: { jobs: ModalRunParamsT[]; group_id?: string },
      ) => {
        try {
          const output = await api<ApiBatch>("/modal/jobs/batch", {
            method: "POST",
            body: JSON.stringify({
              jobs: params.jobs,
              group_id: params.group_id,
              ...ownerFields(getIdentity()),
            }),
          });
          const summary = summarizeBatch(output);
          return result(jobText(summary), summary);
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
}

/** Identity-less tool set, for schema parity checks and tool-name listings. */
export const modalChildTools: ToolDefinition<any>[] = makeModalChildTools();

export default function (pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT_CHILD) return;
  const identity = trackSubagentChildIdentity(pi);
  for (const tool of makeModalChildTools(identity)) pi.registerTool(tool);
}
