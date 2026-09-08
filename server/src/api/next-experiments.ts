import type { FastifyInstance, FastifyReply } from "fastify";
import { researchProject } from "./notebook-research.ts";
import { NEXT_EXPERIMENT_REQUEST_ID } from "../../../web/src/lib/next-experiments.ts";
import { inspectGeneration } from "../agent/next-experiment-receipts.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { nextExperimentView, generateNextExperiments, chooseNextExperiment, NextExperimentError } from "../agent/next-experiments.ts";
function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof NextExperimentError) return reply.code(error.status).send({ detail: error.message, code: error.code, ...(error.costUsd !== undefined ? { costUsd: error.costUsd, modelCallRecorded: true } : {}) });
  if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message });
  throw error;
}
export async function registerNextExperimentRoutes(app: FastifyInstance): Promise<void> {
  type Params = { sessionId: string; entryId: string };
  const base = "/sessions/:sessionId/notebook/:entryId/next-experiments";
  const source = (params: Params) => ({ sessionId: params.sessionId, entryId: params.entryId });
  app.get<{ Params: Params }>(base, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await nextExperimentView(researchProject(req), source(req.params)); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: Params & { requestId: string } }>(`${base}/requests/:requestId`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!NEXT_EXPERIMENT_REQUEST_ID.test(req.params.requestId)) throw new SandboxError(400, "Invalid planning request id");
      return inspectGeneration(researchProject(req), source(req.params), req.params.requestId);
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/generate`, { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await generateNextExperiments(researchProject(req), source(req.params), req.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/decision`, { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await chooseNextExperiment(researchProject(req), source(req.params), req.body); } catch (e) { return fail(reply, e); }
  });
}
