import type { FastifyInstance } from "fastify";
import { currentProjectId } from "../scope.ts";
import { resolvePaths } from "../projects.ts";
import { getSession, listSessions } from "../agent/session-registry.ts";
import { subagentHost } from "../agent/subagent-control.ts";
import { modalJobManager } from "../modal/manager.ts";
import { isTerminalModalState } from "../modal/types.ts";
import { schedulerSessionId } from "../agent/scheduler-state.ts";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
type Rec = Record<string, any>;
export async function registerSubagentRoutes(app: FastifyInstance) {
  async function host(id: string) {
    const projectId = currentProjectId();
    if (!ID.test(id) || !await getSession(projectId, resolvePaths(projectId), id)) throw new Error("Session not found");
    return subagentHost(projectId, id);
  }
  app.get("/subagents/sessions", async () => {
    const paths = resolvePaths(currentProjectId());
    // Schedule fires run on the resident session, which the chat list hides;
    // list it once, labelled, so scheduled runs can be inspected, steered or
    // stopped (it otherwise appeared as an anonymous "Chat").
    const resident = schedulerSessionId(paths);
    const sessions: Rec[] = (await listSessions(paths)).filter((s) => s.id !== resident)
      .map((s) => ({ id: s.id, name: s.name || s.firstMessage?.slice(0, 80) || "Chat", modified: s.modified }));
    if (resident && ID.test(resident)) sessions.push({ id: resident, name: "Scheduled runs", resident: true });
    return { sessions };
  });
  app.get<{ Params: { id: string } }>("/sessions/:id/subagents", async (req, reply) => {
    try {
      const h = await host(req.params.id);
      const result = await h.rpc("status");
      return { text: result.text || "", fleet: result.fleet, asyncSnapshot: result.asyncSnapshot,
        compute: modalJobManager.list(currentProjectId(), { sessionId: req.params.id }).filter((j) => !isTerminalModalState(j.state)).map((j) => ({ id: j.id, state: j.state, label: j.request.label || j.id })) };
    } catch (error) { return reply.code(400).send({ detail: (error as Error).message }); }
  });
  app.post<{ Params: { id: string; action: string }; Body: Rec }>("/sessions/:id/subagents/:action", async (req, reply) => {
    try {
      const h = await host(req.params.id);
      const action = req.params.action, body = req.body ?? {};
      if (action === "preflight") {
        if (typeof body.agent !== "string" || body.agent.length > 200) throw new Error("Agent name required");
        return h.preflight(body);
      }
      if (!["transcript", "steer", "stop", "resume"].includes(action) || typeof body.runId !== "string" || !ID.test(body.runId)) throw new Error("Invalid specialist action or run id");
      // Reject prefixes, foreign-session ids and caller-controlled directories.
      const snapshot = await h.rpc("status");
      const runs: Rec[] = snapshot.asyncSnapshot?.runs ?? [];
      const nodes = (rows: Rec[]): Rec[] => rows.flatMap((row) => [row, ...nodes(row.children ?? [])]);
      const child = body.index === undefined ? undefined : nodes(runs).find((row) => row.control?.runId === body.runId && row.control.index === body.index);
      if (body.index === undefined ? !runs.some((run) => run.id === body.runId) : !child) throw new Error("Run or child is not present in this session's fleet");
      const params: Rec = { id: body.runId };
      if (body.index !== undefined) {
        if (!Number.isInteger(body.index) || body.index < 0 || body.index > 10000) throw new Error("Invalid child index");
        params.index = body.index;
      }
      if (action === "transcript") {
        const result = await h.rpc("status", { ...params, view: "transcript", lines: 200 });
        return { text: result.text || "" };
      }
      if (action === "steer" || action === "resume") {
        if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 16000) throw new Error("A message of 1–16000 characters is required");
        params.message = body.message.trim();
      }
      // Actual resolved-model admission applies to resume too, including free
      // local/subscription models at a paid budget cap.
      if (action === "stop" && child) { delete params.index; params.childId = child.control.childId; }
      const result = await h.rpc(action, params);
      return { text: result.text || result.message || "Request acknowledged." };
    } catch (error) { return reply.code(400).send({ detail: (error as Error).message }); }
  });
}
