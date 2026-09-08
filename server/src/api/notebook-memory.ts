import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { researchProject } from "./notebook-research.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { NotebookMemoryError, searchNotebookMemory, readNotebookMemory, executeMemoryRecall } from "../agent/notebook-memory.ts";
function projectFor(req: FastifyRequest, id: string): string {
  if (researchProject(req) !== id) throw new SandboxError(404, "Memory source must belong to the active project; no fallback was used");
  return id;
}
function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof NotebookMemoryError) return reply.code(error.statusCode).send({ detail: error.message, code: error.code });
  if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message });
  throw error;
}
export async function registerNotebookMemoryRoutes(app: FastifyInstance): Promise<void> {
  const base = "/projects/:projectId/notebook/memory";
  type Params = { projectId: string };
  app.post<{ Params: Params; Body: unknown }>(`${base}/search`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await searchNotebookMemory(projectFor(req, req.params.projectId), req.body); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: Params; Querystring: { source?: string; expectedDigest?: string } }>(`${base}/record`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const projectId = projectFor(req, req.params.projectId);
      let source: unknown;
      try { if (!req.query.source || req.query.source.length > 4096) throw new Error(); source = JSON.parse(req.query.source); }
      catch { throw new NotebookMemoryError(400, "INVALID_SOURCE", "A bounded JSON source query parameter is required"); }
      return await readNotebookMemory(projectId, source, req.query.expectedDigest);
    } catch (e) { return fail(reply, e); }
  });
  // Same bounded text envelope as the lead tool; a child never reads arbitrary
  // paths or chooses a project through tool arguments.
  app.post<{ Params: Params; Body: unknown }>(`${base}/tool`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await executeMemoryRecall(projectFor(req, req.params.projectId), req.body); } catch (e) { return fail(reply, e); }
  });
}
