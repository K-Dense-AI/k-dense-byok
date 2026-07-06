/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Replaces ADK's /apps/.../sessions + /run_sse. Each session is a Pi JSONL
 * conversation; `/sessions/:id/run` streams the agent's events as SSE using the
 * compact client schema from agent/events.ts, then emits a terminal `cost`
 * frame sourced from Pi's per-session usage accounting.
 */
import type { FastifyInstance } from "fastify";
import { activePaths, getProject } from "../projects.ts";
import { corsResponseHeaders } from "../cors.ts";
import { currentProjectId } from "../scope.ts";
import { toClientFrame, type ClientFrame } from "../agent/events.ts";
import { setFusionConfig } from "../agent/fusion-bridge.ts";
import {
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewAnswer,
} from "../agent/interview.ts";
import { setSessionComputeTarget } from "../agent/modal-tool.ts";
import { resolveModel } from "../agent/models.ts";
import { readNotebookEntries } from "../agent/notebook-store.ts";
import { notebookToMarkdown } from "../agent/notebook-export.ts";
import {
  findSessionFile,
  toNotebook,
  toShellScript,
} from "../agent/session-export.ts";
import { toHistory } from "../agent/session-history.ts";
import {
  createSession,
  getModelRegistry,
  getSession,
  listSessions,
} from "../agent/session-registry.ts";
import { parseThinkingLevel } from "../agent/thinking.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
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
  /** Full OpenRouter Fusion request body for a "fusion/<id>" model selection. */
  fusionConfig?: Record<string, unknown>;
  /** Default Modal compute instance id for `modal_run` this run ("local" / unset = none). */
  computeTarget?: string;
}

// Sessions with a run in flight, claimed synchronously. `session.isStreaming`
// flips true only after awaits inside prompt(), so concurrent POSTs could
// otherwise both pass the guard and the loser's close handler would abort the
// winner's live turn.
const activeRuns = new Set<string>();

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

  // Full transcript of a stored session, replayed as client frames so the UI
  // can rebuild a past chat after a reload ("reopen session").
  app.get<{ Params: { id: string } }>("/sessions/:id/history", async (req, reply) => {
    try {
      const paths = activePaths();
      const file = findSessionFile(paths, req.params.id);
      if (!file) {
        reply.code(404);
        return { detail: "No such session" };
      }
      return { messages: toHistory(file, paths.sandbox) };
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/costs", async (req, reply) => {
    try {
      return sessionCostSummary(req.params.id, currentProjectId());
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/notebook", async (req, reply) => {
    try {
      return { entries: readNotebookEntries(req.params.id, currentProjectId()) };
    } catch (exc) {
      reply.code(400);
      return { detail: (exc as Error).message };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/notebook/export",
    async (req, reply) => {
      const format = req.query.format ?? "md";
      if (format !== "md") {
        reply.code(400);
        return { detail: "Only format=md is supported (PDF is exported client-side)" };
      }
      try {
        const projectId = currentProjectId();
        const entries = readNotebookEntries(req.params.id, projectId);
        const projectName = getProject(projectId)?.name ?? projectId;
        const md = notebookToMarkdown(entries, { sessionId: req.params.id, projectName });
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="lab-notebook-${req.params.id}.md"`,
        );
        return md;
      } catch (exc) {
        reply.code(400);
        return { detail: (exc as Error).message };
      }
    },
  );

  // Reproducibility export: a runnable shell script (?format=sh) or a markdown
  // lab notebook (?format=md) reconstructed from the Pi session log.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/export",
    async (req, reply) => {
      try {
        const format = req.query.format === "md" ? "md" : "sh";
        const paths = activePaths();
        const file = findSessionFile(paths, req.params.id);
        if (!file) {
          reply.code(404);
          return { detail: "No such session" };
        }
        const body =
          format === "md"
            ? toNotebook(file, req.params.id, paths.sandbox)
            : toShellScript(file, req.params.id, paths.sandbox);
        const ext = format === "md" ? "md" : "sh";
        reply.type(format === "md" ? "text/markdown" : "text/x-shellscript");
        reply.header(
          "Content-Disposition",
          `attachment; filename="session-${req.params.id}.${ext}"`,
        );
        return body;
      } catch (err) {
        reply.code(400);
        return { detail: (err as Error).message };
      }
    },
  );

  // The interview tool blocks its run until the user answers here (or the
  // form is dismissed). 404 = nothing waiting (answered, timed out, aborted);
  // 400 = fixable submission problem — the pending interview is NOT consumed,
  // so the form can correct and resubmit.
  app.post<{ Params: { id: string; toolCallId: string }; Body: InterviewAnswer }>(
    "/sessions/:id/interview/:toolCallId",
    async (req, reply) => {
      const body = (req.body ?? {}) as { cancelled?: boolean; responses?: unknown };
      const answer = (
        body.cancelled ? { cancelled: true } : { responses: body.responses ?? [] }
      ) as InterviewAnswer;
      const invalid = validateAnswer(answer);
      if (invalid) {
        reply.code(400);
        return { detail: invalid };
      }
      const ok = resolveInterview(
        currentProjectId(),
        req.params.id,
        req.params.toolCallId,
        answer,
      );
      if (!ok) {
        reply.code(404);
        return { detail: "No pending interview for this tool call" };
      }
      return { ok: true };
    },
  );

  // Pending interview for a session (lets a reconnecting UI re-render the form).
  app.get<{ Params: { id: string } }>("/sessions/:id/interview", async (req) => {
    return { pending: pendingInterviewFor(currentProjectId(), req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const session = await getSession(currentProjectId(), activePaths(), req.params.id);
    if (!session) return { ok: true, restored: [] };
    // Clear BEFORE abort so a pending steer can't be delivered into the
    // dying loop; the texts go back to the composer client-side.
    const cleared = session.clearQueue();
    await session.abort();
    return { ok: true, restored: [...cleared.steering, ...cleared.followUp] };
  });

  // Steering side-channel: queue a message into the LIVE run (delivered by Pi
  // after the current tool calls, before the next LLM call). Never creates a
  // run or an SSE stream — the /run stream carries the delivery + queue_update
  // frames. 409 reason "not_streaming" tells the client to fall back to a
  // normal run.
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/sessions/:id/steer",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      // A steer extends a live run's spend past what the run-start check
      // gated, so re-check the cap here.
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      await session.steer(message);
      // The run can end between the guard and the queue write; a steer left
      // behind would silently deliver into the NEXT run, so pull it back out.
      if (!session.isStreaming) {
        session.clearQueue();
        reply.code(409);
        return { detail: "Run ended before the message was delivered", reason: "not_streaming" };
      }
      return { ok: true, pending: [...session.getSteeringMessages()] };
    },
  );

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
      // One run at a time per session. The frontend blocks sending while a tab
      // is streaming, so this is a guard against races/double-submits rather
      // than a normal path. (Pi's followUp queueing returns immediately, which
      // would orphan the SSE stream and abort the live turn — so we reject.)
      const runKey = `${projectId}:${req.params.id}`;
      if (session.isStreaming || activeRuns.has(runKey)) {
        reply.code(409);
        return { detail: "Session is already streaming a response" };
      }

      const body = req.body ?? {};
      if (!body.message || !body.message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      // No awaits between the guard above and this claim, so it is atomic.
      activeRuns.add(runKey);
      // For a Fusion run we disable Pi's local tools for the turn (see below).
      // Remember the real active set so we can restore it in the finally; `null`
      // means "not a fusion run, nothing to restore".
      let savedToolNames: string[] | null = null;
      try {
        // Stash this run's selected compute instance so the modal_run tool uses
        // it as the default when the agent doesn't name one ("local"/unset clears it).
        setSessionComputeTarget(session.sessionId, body.computeTarget ?? null);
        const isFusion = Boolean(body.model && body.model.startsWith("fusion/"));
        if (isFusion) {
          // Fusion is load-bearing for the spend cap: the cost-bearing Model
          // (priced from the panel sum) and the body-rewrite must be applied
          // together for THIS run. If resolution fails (e.g. catalogue priced
          // no panel model), do NOT swallow it and run at the prior model's
          // cost — abort, since the body would still be rewritten to fusion.
          try {
            await session.setModel(
              resolveModel(body.model, getModelRegistry(), body.fusionConfig),
            );
            setFusionConfig(session.sessionId, body.fusionConfig ?? null);
            // Disable Pi's local agentic tools for this turn so OpenRouter Fusion
            // runs deterministically. Stripping `tools` from the wire body (in
            // fusion-bridge's before_provider_request) is NOT enough: Pi executes
            // any tool_call the model returns by name-matching against the live
            // tool registry (agent.state.tools / the loop's context.tools
            // snapshot), independent of what the HTTP body advertised. With the
            // registry non-empty, the model is still offered ls/read/etc. and any
            // returned tool_call still executes — so the agent keeps looping
            // instead of producing the single fused answer. setActiveToolsByName
            // is the supported API: it empties agent.state.tools (so the loop's
            // snapshot carries no tools and any stray tool_call resolves to "not
            // found") AND rebuilds the system prompt without tool guidelines.
            // Restored in the finally so non-fusion runs keep all tools.
            savedToolNames = session.getActiveToolNames();
            session.setActiveToolsByName([]);
          } catch (err) {
            // Make sure no stale fusion config rewrites this run's body.
            // (The outer finally releases the activeRuns claim on return.)
            setFusionConfig(session.sessionId, null);
            reply.code(400);
            return {
              detail: `Fusion model could not be prepared: ${(err as Error).message}`,
            };
          }
        } else {
          // Non-fusion run: clear any fusion config so the extension passes the
          // payload through untouched.
          setFusionConfig(session.sessionId, null);
          if (body.model) {
            try {
              await session.setModel(resolveModel(body.model, getModelRegistry()));
            } catch (err) {
              req.log.warn({ err }, "setModel failed; keeping current model");
            }
          }
        }
        if (body.thinkingLevel !== undefined) {
          const level = parseThinkingLevel(body.thinkingLevel);
          if (level) session.setThinkingLevel(level);
          else req.log.warn({ thinkingLevel: body.thinkingLevel }, "ignoring invalid thinkingLevel");
        }

        // Take over the socket for Server-Sent Events.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...corsResponseHeaders(req.headers.origin),
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

        const sandboxRoot = activePaths().sandbox;
        // Usage tallied straight from turn_end events. getSessionStats() is
        // recomputed from the in-context messages, so auto-compaction mid-run
        // can shrink the cumulative stats and make the before/after delta lie
        // low; the per-turn events are immune to that.
        const turnTally = emptySnapshot();
        const unsub = session.subscribe((ev) => {
          if (ev.type === "turn_end") {
            const usage = (ev.message as { usage?: Parameters<typeof addTurnUsage>[1] }).usage;
            if (usage) addTurnUsage(turnTally, usage);
          }
          const frame = toClientFrame(ev, sandboxRoot);
          if (frame) write(frame);
        });

        req.raw.on("close", () => {
          if (session.isStreaming) session.abort().catch(() => {});
        });

        // errorMessage is sticky on the session; only report it if THIS run set it.
        const priorError = session.state.errorMessage;
        const before = snapshot(session);
        try {
          await session.prompt(body.message ?? "");
          // Surface a provider/agent error that didn't already stream as a frame
          // (e.g. an auth failure that produced an empty assistant turn).
          const errorMessage = session.state.errorMessage;
          if (errorMessage && errorMessage !== priorError) {
            write({ type: "error", message: errorMessage });
          }
        } catch (err) {
          write({ type: "error", message: (err as Error).message });
        } finally {
          unsub();
          // Ledger in the finally: a run that threw mid-turn still spent real
          // tokens. The stats delta catches a partial turn that never reached
          // turn_end; the tally catches compaction — take the max of the two.
          try {
            const run = snapshotMax(snapshotDelta(before, snapshot(session)), turnTally);
            recordRun({
              sessionId: req.params.id,
              projectId,
              model: session.model?.id ?? "unknown",
              before: emptySnapshot(),
              after: run,
            });
            const stats = session.getSessionStats();
            // `cost` is the session's full ledgered spend (subagents included,
            // restart/compaction-proof); `tokens` is Pi's in-context cumulative;
            // `runCost`/`runTokens` are the delta for THIS turn, so the UI can
            // attribute a price to the message that just completed.
            write({
              type: "cost",
              cost: sessionCostSummary(req.params.id, projectId).totalUsd,
              tokens: stats.tokens,
              runCost: run.costUsd,
              runTokens: run.total,
            });
            write({ type: "done" });
          } catch (err) {
            req.log.warn({ err }, "failed to ledger run cost");
          }
          if (!raw.writableEnded) raw.end();
        }
      } finally {
        // Restore the local tool set disabled for a fusion run (covers every
        // exit path, including early returns like the budget cap). No-op for
        // non-fusion runs (savedToolNames stays null).
        if (savedToolNames !== null) {
          session.setActiveToolsByName(savedToolNames);
        }
        activeRuns.delete(runKey);
      }
    },
  );
}
