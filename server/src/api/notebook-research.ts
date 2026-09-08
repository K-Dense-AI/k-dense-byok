import type { FastifyInstance, FastifyRequest } from "fastify";
import { currentProjectId } from "../scope.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { touchProject } from "../projects.ts";
import { freezeAnalysisPlan, previewAnalysisPlan, readAnalysisPlans, recordPlanDeviation } from "../agent/notebook-plans.ts";
import { resolveNotebookResult } from "../agent/notebook-results.ts";
import type { PlanSource } from "../../../web/src/lib/notebook-plans.ts";

export function researchProject(req: FastifyRequest): string {
  const projectId = currentProjectId();
  // The general scope hook falls back to default for a missing project. Never
  // let an explicitly scoped approval/result request operate on that fallback.
  const requested = req.headers["x-project-id"];
  if (requested !== undefined && requested !== projectId) throw new SandboxError(404, "Requested project is unavailable; no fallback project was used");
  return projectId;
}

export async function registerNotebookResearchRoutes(app: FastifyInstance): Promise<void> {
  type Params = { sessionId: string; entryId: string };
  const base = "/sessions/:sessionId/notebook/:entryId";
  const source = (params: Params): PlanSource => ({ sessionId: params.sessionId, entryId: params.entryId });
  app.get<{ Params: Params }>(`${base}/plans`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return readAnalysisPlans(researchProject(req), source(req.params)); }
    catch (error) { if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message }); throw error; }
  });
  for (const [action, handler] of Object.entries({ preview: previewAnalysisPlan, freeze: freezeAnalysisPlan, deviations: recordPlanDeviation })) {
    app.post<{ Params: Params; Body: unknown }>(`${base}/plans/${action}`, async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const projectId = researchProject(req);
        const result = await handler(projectId, source(req.params), req.body);
        if (action !== "preview") touchProject(projectId);
        return result;
      } catch (error) {
        if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message });
        throw error;
      }
    });
  }
  app.get<{ Params: Params & { index: string } }>(`${base}/results/:index`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await resolveNotebookResult(researchProject(req), req.params.sessionId, req.params.entryId, Number(req.params.index)); }
    catch (error) { if (error instanceof SandboxError) return reply.code(error.statusCode).send({ detail: error.message }); throw error; }
  });
}
