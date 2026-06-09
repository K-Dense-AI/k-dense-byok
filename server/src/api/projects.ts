/**
 * Project CRUD endpoints — TS port of the projects_router in kady_agent/projects.py.
 * Costs and sandbox/init endpoints are added in later phases.
 */
import type { FastifyInstance } from "fastify";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  UNSET,
  type UpdateProjectInput,
} from "../projects.ts";
import { projectCostSummary } from "../cost/ledger.ts";

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/projects", async () => listProjects());

  app.post("/projects", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const meta = createProject({
        name: String(body.name ?? ""),
        description: body.description ? String(body.description) : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        projectId: body.id ? String(body.id) : undefined,
        spendLimitUsd:
          body.spendLimitUsd === undefined
            ? undefined
            : (body.spendLimitUsd as number | null),
      });
      reply.code(201);
      return meta;
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    const meta = getProject(req.params.projectId);
    if (!meta) {
      reply.code(404);
      return { detail: "Project not found" };
    }
    return meta;
  });

  app.patch<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: UpdateProjectInput = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.tags !== undefined) patch.tags = (body.tags as unknown[]).map(String);
    if (body.archived !== undefined) patch.archived = Boolean(body.archived);
    // Distinguish "absent" (leave alone) from "null" (clear the cap).
    patch.spendLimitUsd = "spendLimitUsd" in body
      ? (body.spendLimitUsd as number | null)
      : UNSET;
    try {
      return updateProject(req.params.projectId, patch);
    } catch (err) {
      reply.code(404);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/costs", async (req) => {
    return projectCostSummary(req.params.projectId);
  });

  app.delete<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    try {
      deleteProject(req.params.projectId);
      reply.code(204);
      return null;
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });
}
