/**
 * Automation endpoints: read-only views of pi-subagents' durable schedules and
 * missions for the active project, plus the few control actions the panel
 * offers (pause / resume / run now / delete; close mission). Actions go through
 * the `subagent` tool on the project's resident scheduler session.
 */
import type { FastifyInstance } from "fastify";
import { currentProjectId } from "../scope.ts";
import { resolvePaths } from "../projects.ts";
import {
  ensureSchedulerSession,
  invokeSubagentAction,
  listMissions,
  listSchedules,
} from "../agent/scheduler.ts";
import { readSchedulerState } from "../agent/scheduler-state.ts";

const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/schedules", async () => {
    const projectId = currentProjectId();
    const state = readSchedulerState(resolvePaths(projectId));
    return {
      schedules: listSchedules(projectId),
      heldByBudget: state.heldByBudget,
      schedulerSessionId: state.sessionId ?? null,
    };
  });

  app.post<{ Params: { id: string; action: string } }>("/schedules/:id/:action", async (req, reply) => {
    const projectId = currentProjectId();
    const { id, action } = req.params;
    if (!SCHEDULE_ID_RE.test(id)) {
      reply.code(400);
      return { detail: "Invalid schedule id" };
    }
    const verb = { pause: "schedule.pause", resume: "schedule.resume", run: "schedule.run", delete: "schedule.delete" }[action];
    if (!verb) {
      reply.code(400);
      return { detail: "action must be pause, resume, run or delete" };
    }
    if (!listSchedules(projectId).some((s) => s.id === id)) {
      reply.code(404);
      return { detail: `No schedule "${id}" in this project` };
    }
    try {
      const result = await invokeSubagentAction(projectId, { action: verb, id });
      return { ok: true, message: result.text, schedules: listSchedules(projectId) };
    } catch (err) {
      reply.code(502);
      return { detail: (err as Error).message };
    }
  });

  app.post("/schedules/ensure-host", async (_req, reply) => {
    try {
      const session = await ensureSchedulerSession(currentProjectId());
      return { ok: session !== null, sessionId: session?.sessionId ?? null };
    } catch (err) {
      reply.code(502);
      return { detail: (err as Error).message };
    }
  });

  app.get("/missions", async () => ({ missions: listMissions(currentProjectId()) }));

  app.post<{ Params: { id: string }; Body: { status?: unknown; summary?: unknown } }>("/missions/:id/close", async (req, reply) => {
    const projectId = currentProjectId();
    if (!SCHEDULE_ID_RE.test(req.params.id)) {
      reply.code(400);
      return { detail: "Invalid mission id" };
    }
    if (!listMissions(projectId).some((m) => m.id === req.params.id)) {
      reply.code(404);
      return { detail: `No mission "${req.params.id}" in this project` };
    }
    const status = req.body?.status === "completed" || req.body?.status === "failed" ? req.body.status : "cancelled";
    const summary = typeof req.body?.summary === "string" ? req.body.summary.slice(0, 2_000) : "Closed from the Automation panel.";
    try {
      const result = await invokeSubagentAction(projectId, { action: "mission.close", missionId: req.params.id, status, summary });
      return { ok: true, message: result.text, missions: listMissions(projectId) };
    } catch (err) {
      reply.code(502);
      return { detail: (err as Error).message };
    }
  });
}
