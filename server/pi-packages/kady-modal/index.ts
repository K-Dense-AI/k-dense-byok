import path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

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
      description: "Hard sandbox lifetime (default 600s).",
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

function projectId(): string {
  return process.env.KADY_PROJECT_ID || path.basename(path.dirname(process.cwd()));
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
  const response = await fetch(`${apiBase()}${route}`, {
    ...init,
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Project-Id": projectId(),
      ...(init.headers ?? {}),
    },
  });
  const data = (await response.json()) as T & { detail?: string; error?: string };
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Modal API returned HTTP ${response.status}`);
  }
  return data;
}

function ownerFields() {
  const subagentRunId = process.env.PI_SUBAGENT_RUN_ID;
  return {
    ...(subagentRunId ? { subagent_run_id: subagentRunId } : {}),
  };
}

async function submit(params: ModalRunParamsT, groupId?: string): Promise<ApiJob> {
  return api<ApiJob>("/modal/jobs", {
    method: "POST",
    body: JSON.stringify({
      ...params,
      ...(groupId ? { group_id: groupId } : {}),
      ...ownerFields(),
    }),
  });
}

async function status(jobId: string, signal?: AbortSignal): Promise<ApiJob> {
  const data = await api<{ job: ApiJob }>(
    `/modal/jobs/${encodeURIComponent(jobId)}`,
    {},
    signal,
  );
  return data.job;
}

function terminal(state: string): boolean {
  return ["succeeded", "failed", "cancelled", "lost"].includes(state);
}

async function waitFor(
  jobId: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<ApiJob> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (true) {
    const job = await status(jobId, signal);
    if (terminal(job.state) || Date.now() >= deadline) return job;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(done, 500);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Wait aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function result(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function failed(error: unknown) {
  return result(`Modal compute request failed: ${error instanceof Error ? error.message : String(error)}`, {
    error: "MODAL_FAILURE",
  });
}

export const modalChildTools: ToolDefinition<any>[] = [
  {
    name: "modal_run",
    label: "Modal compute",
    description:
      "Run durable remote Modal CPU/GPU compute, wait, and return logs/results. Aborting cancels this job.",
    parameters: ModalRunParams,
    execute: async (_id, params: ModalRunParamsT, signal?: AbortSignal) => {
      let job: ApiJob | undefined;
      const cancel = () => {
        if (job) void api(`/modal/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        job = await submit(params);
        if (signal?.aborted) cancel();
        await waitFor(job.id, params.timeout_sec ?? 600);
        const output = await api<Record<string, unknown>>(
          `/modal/jobs/${encodeURIComponent(job.id)}/results`,
        );
        return result(JSON.stringify(output, null, 2), output);
      } catch (error) {
        if (signal?.aborted) cancel();
        return failed(error);
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
        const job = await submit(params);
        return result(JSON.stringify(job, null, 2), job);
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
        const job = await status(params.job_id);
        return result(JSON.stringify(job, null, 2), job);
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
        const job = await waitFor(params.job_id, params.timeout_sec ?? 600, signal);
        return result(JSON.stringify(job, null, 2), job);
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
        const job = await api<ApiJob>(
          `/modal/jobs/${encodeURIComponent(params.job_id)}/cancel`,
          { method: "POST" },
        );
        return result(JSON.stringify(job, null, 2), job);
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
        const output = await api<Record<string, unknown>>(
          `/modal/jobs/${encodeURIComponent(params.job_id)}/results`,
        );
        return result(JSON.stringify(output, null, 2), output);
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
        const output = await api<Record<string, unknown>>("/modal/jobs/batch", {
          method: "POST",
          body: JSON.stringify({
            jobs: params.jobs,
            group_id: params.group_id,
            ...ownerFields(),
          }),
        });
        return result(JSON.stringify(output, null, 2), output);
      } catch (error) {
        return failed(error);
      }
    },
  },
];

export default function (pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT_CHILD) return;
  for (const tool of modalChildTools) pi.registerTool(tool);
}
