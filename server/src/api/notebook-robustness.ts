import type { FastifyInstance, FastifyReply } from "fastify";
import { researchProject } from "./notebook-research.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { ModalJobError } from "../modal/types.ts";
import { notebookRobustness, type NotebookRobustnessService } from "../agent/notebook-robustness.ts";

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ModalJobError) return reply.code(error.statusCode).send({ detail: error.message, code: error.code });
  if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message });
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ detail: "Required input or workflow record is missing; refresh the source and prepare again" });
  throw error;
}
export async function registerNotebookRobustnessRoutes(app: FastifyInstance, service: NotebookRobustnessService = notebookRobustness): Promise<void> {
  type Params = { sessionId: string; entryId: string; workflowId: string };
  const base = "/sessions/:sessionId/notebook/:entryId/robustness";
  const source = (p: Params) => ({ sessionId: p.sessionId, entryId: p.entryId });
  app.get<{ Params: Params }>(base, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return service.list(researchProject(req), source(req.params)); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/preview`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await service.preview(researchProject(req), source(req.params), req.body); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: Params }>(`${base}/:workflowId`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return service.get(researchProject(req), source(req.params), req.params.workflowId); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/:workflowId/approve`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await service.approve(researchProject(req), source(req.params), req.params.workflowId, req.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: Params }>(`${base}/:workflowId/cancel`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await service.cancel(researchProject(req), source(req.params), req.params.workflowId); } catch (e) { return fail(reply, e); }
  });
}
