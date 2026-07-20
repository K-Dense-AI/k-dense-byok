import type { FastifyInstance, FastifyReply } from "fastify";
import { currentProjectId } from "../scope.ts";
import { modalConfigured } from "../config.ts";
import {
  DEFAULT_INSTANCE_ID,
  MODAL_CATALOG_METADATA,
  publicInstanceCatalog,
} from "../modal/catalog.ts";
import { modalJobManager } from "../modal/manager.ts";
import { ModalJobError, type ModalJobOwner, type ModalJobRequest } from "../modal/types.ts";

function requestFromBody(body: Record<string, unknown>): ModalJobRequest {
  const image =
    body.image && typeof body.image === "object" && !Array.isArray(body.image)
      ? (body.image as ModalJobRequest["image"])
      : undefined;
  return {
    command: String(body.command ?? ""),
    instance: body.instance === undefined ? undefined : String(body.instance),
    gpuCount:
      body.gpuCount === undefined && body.gpu_count === undefined
        ? undefined
        : Number(body.gpuCount ?? body.gpu_count),
    gpuFallback: (body.gpuFallback ?? body.gpu_fallback) as string[] | undefined,
    image,
    environment:
      body.environment === undefined ? undefined : String(body.environment),
    cache:
      body.cache === "none" ? "none" : body.cache === "project" ? "project" : undefined,
    filesIn: (body.filesIn ?? body.files_in) as string[] | undefined,
    filesOut: (body.filesOut ?? body.files_out) as string[] | undefined,
    timeoutSec:
      body.timeoutSec === undefined && body.timeout_sec === undefined
        ? undefined
        : Number(body.timeoutSec ?? body.timeout_sec),
    groupId:
      body.groupId === undefined && body.group_id === undefined
        ? undefined
        : String(body.groupId ?? body.group_id),
    label: body.label === undefined ? undefined : String(body.label),
  };
}

function ownerFromBody(body: Record<string, unknown>): ModalJobOwner {
  const subagentRunId =
    body.subagentRunId === undefined && body.subagent_run_id === undefined
      ? undefined
      : String(body.subagentRunId ?? body.subagent_run_id);
  const sessionId =
    body.sessionId === undefined && body.session_id === undefined
      ? subagentRunId
        ? `subagent-${subagentRunId}`
        : "modal-api"
      : String(body.sessionId ?? body.session_id);
  return {
    sessionId,
    submittedBy: subagentRunId ? "subagent" : "api",
    ...(subagentRunId ? { subagentRunId } : {}),
    ...(body.runId || body.run_id ? { runId: String(body.runId ?? body.run_id) } : {}),
  };
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ModalJobError) {
    reply.code(error.statusCode);
    return {
      detail: error.message,
      error: error.code,
      retryable: error.retryable,
    };
  }
  reply.code(500);
  return { detail: error instanceof Error ? error.message : String(error), error: "INTERNAL" };
}

export async function registerModalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/modal/instances", async () => ({
    modalConfigured: modalConfigured(),
    instances: publicInstanceCatalog(),
    defaults: {
      instanceId: DEFAULT_INSTANCE_ID,
      gpuCount: 1,
      fallback: null,
      cache: "project",
    },
    estimatedBilling: true,
    pricing: MODAL_CATALOG_METADATA,
  }));

  app.get<{
    Querystring: {
      state?: string;
      status?: string;
      groupId?: string;
      sessionId?: string;
      limit?: string;
    };
  }>("/modal/jobs", async (req) => {
    const projectId = currentProjectId();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    return {
      jobs: modalJobManager
        .list(projectId, {
          state: req.query.status ?? req.query.state,
          groupId: req.query.groupId,
          sessionId: req.query.sessionId,
        })
        .slice(0, Number.isFinite(limit) ? limit : 100),
      groups: modalJobManager.groups(projectId),
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/modal/jobs", async (req, reply) => {
    try {
      const body = req.body ?? {};
      const job = modalJobManager.submit(
        currentProjectId(),
        requestFromBody(body),
        ownerFromBody(body),
      );
      reply.code(202);
      return job;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Body: { jobs?: Record<string, unknown>[]; groupId?: string; group_id?: string } }>(
    "/modal/jobs/batch",
    async (req, reply) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rawJobs = Array.isArray(body.jobs) ? (body.jobs as Record<string, unknown>[]) : [];
        const groupId = body.groupId ?? body.group_id;
        const jobs = rawJobs.map((job) =>
          requestFromBody({
            ...job,
            ...(groupId === undefined ? {} : { groupId }),
          }),
        );
        const result = modalJobManager.submitBatch(
          currentProjectId(),
          jobs,
          ownerFromBody(body),
        );
        reply.code(202);
        return result;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { jobId: string }; Querystring: { eventsAfter?: string } }>(
    "/modal/jobs/:jobId",
    async (req, reply) => {
      try {
        const job = modalJobManager.get(currentProjectId(), req.params.jobId);
        const after = Number(req.query.eventsAfter ?? 0);
        return {
          job,
          events: modalJobManager.store.events(
            currentProjectId(),
            req.params.jobId,
            Number.isFinite(after) ? after : 0,
          ),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{
    Params: { jobId: string };
    Querystring: { stream?: string; after?: string; cursor?: string; limit?: string };
  }>("/modal/jobs/:jobId/logs", async (req, reply) => {
    try {
      const stream = req.query.stream ?? "stdout";
      if (stream !== "stdout" && stream !== "stderr") {
        throw new ModalJobError("INVALID_STREAM", "stream must be stdout or stderr");
      }
      const cursor = Number(req.query.cursor ?? req.query.after ?? 0);
      const limit = Number(req.query.limit ?? 64 * 1024);
      reply.header("Cache-Control", "no-store");
      return {
        stream,
        ...modalJobManager.store.readLog(
          currentProjectId(),
          req.params.jobId,
          stream,
          Number.isFinite(cursor) ? cursor : 0,
          Number.isFinite(limit) ? limit : 64 * 1024,
        ),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { jobId: string } }>(
    "/modal/jobs/:jobId/cancel",
    async (req, reply) => {
      try {
        return await modalJobManager.cancel(currentProjectId(), req.params.jobId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { jobId: string }; Body: Record<string, unknown> }>(
    "/modal/jobs/:jobId/retry",
    async (req, reply) => {
      try {
        const job = modalJobManager.retry(
          currentProjectId(),
          req.params.jobId,
          req.body ? ownerFromBody(req.body) : undefined,
        );
        reply.code(202);
        return job;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/modal/jobs/:jobId/results",
    async (req, reply) => {
      try {
        return modalJobManager.result(currentProjectId(), req.params.jobId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // Action-style alias used by the UI; collection is already part of every
  // terminal manager path, so this returns the durable installed result.
  app.post<{ Params: { jobId: string } }>(
    "/modal/jobs/:jobId/results",
    async (req, reply) => {
      try {
        return modalJobManager.result(currentProjectId(), req.params.jobId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get("/modal/groups", async () => ({
    groups: modalJobManager.groups(currentProjectId()),
  }));

  app.get<{ Params: { groupId: string } }>(
    "/modal/groups/:groupId",
    async (req, reply) => {
      try {
        return modalJobManager.group(currentProjectId(), req.params.groupId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get("/modal/cache", async () => modalJobManager.cache(currentProjectId()));

  app.delete("/modal/cache", async (_req, reply) => {
    try {
      return await modalJobManager.clearCache(currentProjectId());
    } catch (error) {
      return fail(reply, error);
    }
  });
}
