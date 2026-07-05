/**
 * Sub-agent settings endpoints (per active project).
 *
 * Backs the Settings → "Sub-agents" panel: list the agents available to the
 * pi-subagents `subagent` tool (project files + package builtins), edit or
 * create project agents, delete them, and restore the default scientific
 * roster. Project agents live in `sandbox/.pi/agents/*.md`; builtins are
 * read-only and can be customized by saving a project agent with the same
 * name (project definitions shadow builtins in discovery order).
 *
 * Changes apply to new chat tabs / subagent runs — live sessions keep the
 * agent set they started with.
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import {
  AGENT_NAME_RE,
  THINKING_LEVELS,
  deleteProjectAgent,
  listAgents,
  restoreDefaultAgents,
  seedAgentFiles,
  setSpecialistEnabled,
  writeProjectAgent,
  type AgentFilePatch,
} from "../agent/agent-files.ts";

function patchFromBody(body: Record<string, unknown>): AgentFilePatch | string {
  const description = String(body.description ?? "").trim();
  const systemPrompt = String(body.systemPrompt ?? "");
  if (!systemPrompt.trim()) return "systemPrompt must not be empty";
  const thinking = body.thinking ? String(body.thinking) : undefined;
  if (thinking && !THINKING_LEVELS.includes(thinking as never)) {
    return `thinking must be one of: ${THINKING_LEVELS.join(", ")}`;
  }
  const mode = body.systemPromptMode ? String(body.systemPromptMode) : undefined;
  if (mode && mode !== "append" && mode !== "replace") {
    return `systemPromptMode must be "append" or "replace"`;
  }
  const boolOrUndef = (v: unknown) => (v === undefined || v === null ? undefined : Boolean(v));
  let extra: Record<string, string> | undefined;
  if (body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)) {
    extra = {};
    for (const [k, v] of Object.entries(body.extra as Record<string, unknown>)) {
      extra[k] = String(v);
    }
    if (Object.keys(extra).length === 0) extra = undefined;
  }
  return {
    description,
    systemPrompt,
    model: body.model ? String(body.model).trim() : undefined,
    thinking,
    tools: body.tools ? String(body.tools).trim() : undefined,
    systemPromptMode: mode as AgentFilePatch["systemPromptMode"],
    inheritProjectContext: boolOrUndef(body.inheritProjectContext),
    inheritSkills: boolOrUndef(body.inheritSkills),
    extra,
  };
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const paths = activePaths();
    // Older projects may predate seeding; make sure the roster exists before
    // the first listing (no-op once the marker file is present).
    seedAgentFiles(paths);
    return { agents: listAgents(paths) };
  });

  app.put<{ Params: { name: string } }>("/agents/:name", async (req, reply) => {
    const name = req.params.name;
    if (!AGENT_NAME_RE.test(name)) {
      reply.code(400);
      return { detail: `Invalid agent name "${name}" (lowercase letters, digits, - and _)` };
    }
    const patch = patchFromBody((req.body ?? {}) as Record<string, unknown>);
    if (typeof patch === "string") {
      reply.code(400);
      return { detail: patch };
    }
    try {
      return { ok: true, agent: writeProjectAgent(activePaths(), name, patch) };
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.delete<{ Params: { name: string } }>("/agents/:name", async (req, reply) => {
    const removed = deleteProjectAgent(activePaths(), req.params.name);
    if (!removed) {
      reply.code(404);
      return { detail: "No such project agent (builtin agents cannot be deleted)" };
    }
    reply.code(204);
    return null;
  });

  app.post("/agents/restore-defaults", async () => {
    const restored = restoreDefaultAgents(activePaths());
    return { ok: true, restored };
  });

  app.post<{ Params: { name: string } }>("/agents/:name/enable", async (req, reply) => {
    const r = setSpecialistEnabled(activePaths(), req.params.name, true);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/agents/:name/disable", async (req, reply) => {
    const r = setSpecialistEnabled(activePaths(), req.params.name, false);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });
}
