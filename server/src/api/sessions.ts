/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Replaces ADK's /apps/.../sessions + /run_sse. Each session is a Pi JSONL
 * conversation; `/sessions/:id/run` streams the agent's events as SSE using the
 * compact client schema from agent/events.ts, then emits a terminal `cost`
 * frame sourced from Pi's per-session usage accounting.
 */
import type { FastifyInstance } from "fastify";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { activePaths } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import { toClientFrame, type ClientFrame } from "../agent/events.ts";
import { resolveModel } from "../agent/models.ts";
import {
  createSession,
  getModelRegistry,
  getSession,
  listSessions,
} from "../agent/session-registry.ts";
import {
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
  type CostSnapshot,
} from "../cost/ledger.ts";

function snapshot(session: { getSessionStats(): { cost: number; tokens: { input: number; output: number; cacheRead: number; total: number } } }): CostSnapshot {
  const s = session.getSessionStats();
  return {
    costUsd: s.cost,
    input: s.tokens.input,
    output: s.tokens.output,
    cacheRead: s.tokens.cacheRead,
    total: s.tokens.total,
  };
}

interface RunBody {
  message?: string;
  model?: string;
  thinkingLevel?: string;
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions", async () => {
    const session = await createSession(currentProjectId(), activePaths());
    return { id: session.sessionId, sessionFile: session.sessionFile };
  });

  app.get("/sessions", async () => {
    const infos = await listSessions(activePaths());
    return infos.map((i) => ({
      id: i.id,
      name: i.name ?? null,
      created: i.created,
      modified: i.modified,
      messageCount: i.messageCount,
      firstMessage: i.firstMessage,
    }));
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/costs", async (req) => {
    return sessionCostSummary(req.params.id, currentProjectId());
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const session = await getSession(currentProjectId(), activePaths(), req.params.id);
    if (session) await session.abort();
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/run",
    async (req, reply) => {
      const projectId = currentProjectId();
      const paths = activePaths();
      const session = await getSession(projectId, paths, req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }

      const body = req.body ?? {};
      if (body.model) {
        try {
          await session.setModel(resolveModel(body.model, getModelRegistry()));
        } catch (err) {
          req.log.warn({ err }, "setModel failed; keeping current model");
        }
      }
      if (body.thinkingLevel) {
        session.setThinkingLevel(body.thinkingLevel as ThinkingLevel);
      }

      // Take over the socket for Server-Sent Events.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const write = (frame: ClientFrame) => {
        if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      };

      // Hard budget cap: refuse to run if the project has reached its limit.
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        write({
          type: "error",
          kind: "budget",
          message:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project ` +
            `settings and retry.`,
        });
        write({ type: "done" });
        raw.end();
        return;
      }

      const wasStreaming = session.isStreaming;
      const unsub = session.subscribe((ev) => {
        const frame = toClientFrame(ev);
        if (frame) write(frame);
      });

      req.raw.on("close", () => {
        if (session.isStreaming) session.abort().catch(() => {});
      });

      const before = snapshot(session);
      try {
        await session.prompt(
          body.message ?? "",
          wasStreaming ? { streamingBehavior: "followUp" } : undefined,
        );
        // Surface a provider/agent error that didn't already stream as a frame
        // (e.g. an auth failure that produced an empty assistant turn).
        const errorMessage = session.state.errorMessage;
        if (errorMessage) write({ type: "error", message: errorMessage });
        recordRun({
          sessionId: req.params.id,
          projectId,
          model: session.model?.id ?? "unknown",
          before,
          after: snapshot(session),
        });
        const stats = session.getSessionStats();
        write({ type: "cost", cost: stats.cost, tokens: stats.tokens });
        write({ type: "done" });
      } catch (err) {
        write({ type: "error", message: (err as Error).message });
      } finally {
        unsub();
        if (!raw.writableEnded) raw.end();
      }
    },
  );
}
