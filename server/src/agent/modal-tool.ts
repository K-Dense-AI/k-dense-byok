import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { currentRunId } from "./run-ids.ts";
import {
  DEFAULT_INSTANCE_ID,
  MODAL_INSTANCE_IDS,
} from "../modal/catalog.ts";
import {
  DEFAULT_MODAL_TIMEOUT_SEC,
  MAX_MODAL_BATCH_SIZE,
  MAX_MODAL_TIMEOUT_SEC,
  modalJobManager,
} from "../modal/manager.ts";
import { ModalJobError, type ModalJobOwner, type ModalJobRequest } from "../modal/types.ts";

const MAX_TOOL_OUTPUT_CHARS = 16_000;

const sessionComputeTargets = new Map<string, string | null>();
export interface SessionComputeOptions {
  gpuCount?: number;
  gpuFallback?: string[];
  cache?: "project" | "none";
}
const sessionComputeOptions = new Map<string, SessionComputeOptions>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

export function setSessionComputeTarget(
  projectId: string,
  sessionId: string,
  instanceId: string | null,
): void {
  sessionComputeTargets.set(
    keyFor(projectId, sessionId),
    instanceId && instanceId !== "local" ? instanceId : null,
  );
}

export function getSessionComputeTarget(
  projectId: string,
  sessionId: string,
): string | null | undefined {
  return sessionComputeTargets.get(keyFor(projectId, sessionId));
}

export function setSessionComputeOptions(
  projectId: string,
  sessionId: string,
  options: SessionComputeOptions | null | undefined,
): void {
  const key = keyFor(projectId, sessionId);
  if (!options) {
    sessionComputeOptions.delete(key);
    return;
  }
  sessionComputeOptions.set(key, {
    ...(options.gpuCount !== undefined ? { gpuCount: options.gpuCount } : {}),
    ...(options.gpuFallback?.length
      ? { gpuFallback: [...options.gpuFallback] }
      : {}),
    ...(options.cache ? { cache: options.cache } : {}),
  });
}

export function getSessionComputeOptions(
  projectId: string,
  sessionId: string,
): SessionComputeOptions | undefined {
  return sessionComputeOptions.get(keyFor(projectId, sessionId));
}

/** Drop a disposed session's compute selection so these maps stay bounded. */
export function clearSessionCompute(projectId: string, sessionId: string): void {
  const key = keyFor(projectId, sessionId);
  sessionComputeTargets.delete(key);
  sessionComputeOptions.delete(key);
}

const ModalImageParams = Type.Object({
  base: Type.Optional(
    Type.String({
      description: "Base registry image (default python:3.13-slim).",
    }),
  ),
  pip: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
  apt: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
});

export const ModalRunParams = Type.Object({
  command: Type.String({
    description: "Shell command to run remotely via `sh` in /workspace.",
  }),
  instance: Type.Optional(
    Type.String({
      description: `Compute instance id (${MODAL_INSTANCE_IDS.join(", ")}). Omit for the chat default or "${DEFAULT_INSTANCE_ID}".`,
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
      maximum: MAX_MODAL_TIMEOUT_SEC,
      description: `Hard sandbox lifetime (default ${DEFAULT_MODAL_TIMEOUT_SEC}s).`,
    }),
  ),
  label: Type.Optional(Type.String({ maxLength: 200 })),
});
export type ModalRunParamsT = Static<typeof ModalRunParams>;

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
    maxItems: MAX_MODAL_BATCH_SIZE,
    description: "Independent jobs submitted under one group id.",
  }),
  group_id: Type.Optional(Type.String()),
});

function requestFromParams(
  params: ModalRunParamsT,
  defaultInstance: string | null | undefined,
  defaultOptions: SessionComputeOptions | undefined,
  groupId?: string,
): ModalJobRequest {
  return {
    command: params.command,
    instance: params.instance ?? defaultInstance ?? DEFAULT_INSTANCE_ID,
    gpuCount: params.gpu_count ?? defaultOptions?.gpuCount,
    gpuFallback: params.gpu_fallback ?? defaultOptions?.gpuFallback,
    image: params.image,
    environment: params.environment,
    cache: params.cache ?? defaultOptions?.cache,
    filesIn: params.files_in,
    filesOut: params.files_out,
    timeoutSec: params.timeout_sec,
    label: params.label,
    groupId,
  };
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return `…(${value.length - MAX_TOOL_OUTPUT_CHARS} earlier characters truncated)\n${value.slice(-MAX_TOOL_OUTPUT_CHARS)}`;
}

function publicJob(job: ReturnType<typeof modalJobManager.get>) {
  return {
    id: job.id,
    job_id: job.id,
    state: job.state,
    label: job.request.label,
    group_id: job.request.groupId,
    instance: job.effectiveInstance ?? job.request.instance,
    gpu_count: job.request.gpuCount,
    exit_code: job.exitCode,
    duration_ms:
      job.finishedAt && job.sandboxCreatedAt
        ? Math.max(0, job.finishedAt - job.sandboxCreatedAt)
        : undefined,
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    files_out: job.outputFiles,
    missing_outputs: job.missingOutputs,
    estimated_cost_usd: job.accounting.estimatedCostUsd,
    cost_usd: job.accounting.estimatedCostUsd,
    error: job.error,
  };
}

function toolFailure(error: unknown) {
  const detail =
    error instanceof ModalJobError
      ? { error: error.code, retryable: error.retryable }
      : { error: "MODAL_FAILURE", retryable: false };
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`Modal compute request failed: ${message}`, detail);
}

export const MODAL_TOOL_NAMES = [
  "modal_run",
  "modal_submit",
  "modal_status",
  "modal_wait",
  "modal_cancel",
  "modal_results",
  "modal_submit_batch",
] as const;

/**
 * Build the hybrid durable Modal tool set. Tools are always registered: when
 * credentials are missing, submission returns NOT_CONFIGURED. This lets warm
 * sessions start working immediately after live credential setup.
 */
export function makeModalTools(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<any>[] {
  const owner = (): ModalJobOwner => {
    const sessionId = getSessionId();
    return {
      sessionId,
      submittedBy: "lead",
      ...(currentRunId(projectId, sessionId) ? { runId: currentRunId(projectId, sessionId)! } : {}),
    };
  };
  const defaultInstance = () =>
    getSessionComputeTarget(projectId, getSessionId()) ?? DEFAULT_INSTANCE_ID;
  const defaultOptions = () =>
    getSessionComputeOptions(projectId, getSessionId());

  const submit = (
    params: ModalRunParamsT,
    groupId?: string,
  ) => modalJobManager.submit(
    projectId,
    requestFromParams(params, defaultInstance(), defaultOptions(), groupId),
    owner(),
  );

  const modalRun: ToolDefinition<typeof ModalRunParams> = {
    name: "modal_run",
    label: "Modal compute",
    description: [
      "Run a command on durable remote Modal CPU/GPU compute and wait for completion.",
      "Backward-compatible blocking tool: required files_in are copied recursively, files_out are installed atomically into the local project sandbox, which remains canonical.",
      "The job is persisted and recoverable. Aborting this blocking call cancels its remote job.",
      "Cost is an explicit estimate (catalogue rate × elapsed sandbox time) and the worst-case timeout cost is reserved before admission.",
    ].join("\n"),
    promptSnippet: "modal_run: run and wait for durable Modal CPU/GPU compute",
    parameters: ModalRunParams,
    execute: async (_id, params, signal) => {
      let jobId: string | undefined;
      const onAbort = () => {
        if (jobId) void modalJobManager.cancel(projectId, jobId);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const submitted = submit(params);
        jobId = submitted.id;
        if (signal?.aborted) await modalJobManager.cancel(projectId, jobId);
        const job = await modalJobManager.wait(projectId, jobId);
        const result = modalJobManager.result(projectId, jobId);
        const summary = publicJob(job);
        return textResult(
          `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(result.stdout) || "(empty)"}\n\n--- stderr ---\n${truncate(result.stderr) || "(empty)"}`,
          summary,
        );
      } catch (error) {
        if (jobId && signal?.aborted) await modalJobManager.cancel(projectId, jobId);
        return toolFailure(error);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  const modalSubmit: ToolDefinition<typeof ModalRunParams> = {
    name: "modal_submit",
    label: "Submit Modal job",
    description:
      "Submit durable Modal CPU/GPU work and return immediately. Async jobs survive chat aborts; use modal_status/modal_wait/modal_results.",
    promptSnippet: "modal_submit: submit durable asynchronous Modal compute",
    parameters: ModalRunParams,
    execute: async (_id, params) => {
      try {
        const job = submit(params);
        const summary = publicJob(job);
        return textResult(JSON.stringify(summary, null, 2), summary);
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  const modalStatus: ToolDefinition<typeof ModalJobIdParams> = {
    name: "modal_status",
    label: "Modal job status",
    description: "Get durable status, timing, accounting, and output metadata for one Modal job.",
    parameters: ModalJobIdParams,
    execute: async (_id, params) => {
      try {
        const value = modalJobManager.result(projectId, params.job_id);
        const summary = publicJob(value.job);
        return textResult(
          `${JSON.stringify(summary, null, 2)}\n\n--- recent stdout ---\n${truncate(value.stdout) || "(empty)"}\n\n--- recent stderr ---\n${truncate(value.stderr) || "(empty)"}`,
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  const modalWait: ToolDefinition<typeof ModalWaitParams> = {
    name: "modal_wait",
    label: "Wait for Modal job",
    description: "Wait for a durable Modal job or return its current state after timeout_sec.",
    parameters: ModalWaitParams,
    execute: async (_id, params, signal) => {
      try {
        const job = await modalJobManager.wait(
          projectId,
          params.job_id,
          (params.timeout_sec ?? 600) * 1000,
          signal,
        );
        const summary = publicJob(job);
        return textResult(JSON.stringify(summary, null, 2), summary);
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  const modalCancel: ToolDefinition<typeof ModalJobIdParams> = {
    name: "modal_cancel",
    label: "Cancel Modal job",
    description: "Request cancellation and terminate the remote Modal sandbox if it exists.",
    parameters: ModalJobIdParams,
    execute: async (_id, params) => {
      try {
        const job = await modalJobManager.cancel(projectId, params.job_id);
        const summary = publicJob(job);
        return textResult(JSON.stringify(summary, null, 2), summary);
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  const modalResults: ToolDefinition<typeof ModalJobIdParams> = {
    name: "modal_results",
    label: "Modal job results",
    description: "Read retained stdout/stderr plus installed output metadata for a Modal job.",
    parameters: ModalJobIdParams,
    execute: async (_id, params) => {
      try {
        const result = modalJobManager.result(projectId, params.job_id);
        const summary = publicJob(result.job);
        return textResult(
          `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(result.stdout) || "(empty)"}\n\n--- stderr ---\n${truncate(result.stderr) || "(empty)"}`,
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  const modalSubmitBatch: ToolDefinition<typeof ModalSubmitBatchParams> = {
    name: "modal_submit_batch",
    label: "Submit Modal batch",
    description: `Submit 1-${MAX_MODAL_BATCH_SIZE} independent durable jobs under one group id.`,
    parameters: ModalSubmitBatchParams,
    execute: async (_id, params) => {
      try {
        const requests = params.jobs.map((job) =>
          requestFromParams(
            job,
            defaultInstance(),
            defaultOptions(),
            params.group_id,
          ),
        );
        const result = modalJobManager.submitBatch(projectId, requests, owner());
        const details = {
          group_id: result.groupId,
          jobs: result.jobs.map(publicJob),
        };
        return textResult(JSON.stringify(details, null, 2), details);
      } catch (error) {
        return toolFailure(error);
      }
    },
  };

  return [
    modalRun,
    modalSubmit,
    modalStatus,
    modalWait,
    modalCancel,
    modalResults,
    modalSubmitBatch,
  ];
}

/** Backward-compatible constructor retained for existing imports/tests. */
export function makeModalTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof ModalRunParams> {
  return makeModalTools(projectId, getSessionId)[0] as ToolDefinition<typeof ModalRunParams>;
}
