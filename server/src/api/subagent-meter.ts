import type { FastifyInstance } from "fastify";
import { currentProjectId } from "../scope.ts";
import { handleSubagentMeter } from "../agent/subagent-meter.ts";
export async function registerSubagentMeterRoutes(app: FastifyInstance) {
  app.post<{ Params: { action: string }; Body: Record<string, unknown> }>("/subagents/meter/:action", async (req, reply) => {
    if (!req.body || req.body.projectId !== currentProjectId()) return reply.code(400).send({ detail: "Project identity mismatch" });
    try { return handleSubagentMeter(req.params.action, req.body); }
    catch (error) { const detail = (error as Error).message; return reply.code(detail.includes("spend limit") ? 402 : 400).send({ detail }); }
  });
}
