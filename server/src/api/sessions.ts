/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Replaces ADK's /apps/.../sessions + /run_sse. Each session is a Pi JSONL
 * conversation; `/sessions/:id/run` streams the agent's events as SSE using the
 * compact client schema from agent/events.ts, then emits a terminal `cost`
 * frame sourced from Pi's per-session usage accounting.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activePaths, getProject, touchProject } from "../projects.ts";
import { corsResponseHeaders } from "../cors.ts";
import { currentProjectId } from "../scope.ts";
import {
  contextUsageForClient,
  contextUsageFrame,
  toClientFrame,
} from "../agent/events.ts";
import { setFusionConfig } from "../agent/fusion-bridge.ts";
import {
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewAnswer,
} from "../agent/interview.ts";
import {
  setSessionComputeOptions,
  setSessionComputeTarget,
  type SessionComputeOptions,
} from "../agent/modal-tool.ts";
import { resolveModel } from "../agent/models.ts";
import { parseRunImages } from "../agent/prompt-images.ts";
import { readNotebookEntries } from "../agent/notebook-store.ts";
import { notebookToMarkdown } from "../agent/notebook-export.ts";
import { buildNotebookZip } from "../agent/notebook-zip.ts";
import {
  normalizeNotebookAnnotations,
  readNotebookAnnotations,
  writeNotebookAnnotations,
} from "../agent/notebook-annotations.ts";
import { MethodsDraftError, runMethodsDraft } from "../agent/methods-draft.ts";
import { mintRunId, setSessionRunId } from "../agent/run-ids.ts";
import { runBroker, type RunHandle } from "../agent/run-broker.ts";
import { SandboxError } from "../sandbox-fs.ts";
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
  /** Optional defaults attached to the selected Modal target. */
  computeOptions?: SessionComputeOptions;
  /** Inline image attachments (base64 + mime type); ride the user message as image blocks. */
  images?: unknown;
}

// Sessions with a run in flight, claimed synchronously. `session.isStreaming`
// flips true only after awaits inside prompt(), so concurrent POSTs could
// otherwise both pass the guard and the loser's close handler would abort the
// winner's live turn.
const activeRuns = new Set<string>();

/** Attach one HTTP response to a broker-owned run. Closing the response only
 * removes this observer; the run itself remains owned by the broker. */
function streamRun(
  req: FastifyRequest,
  reply: FastifyReply,
  handle: RunHandle,
  after = 0,
): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsResponseHeaders(req.headers.origin),
  });

  let unsubscribe = () => {};
  const detach = () => unsubscribe();
  raw.on("close", detach);
  unsubscribe = handle.subscribe({
    after,
    onFrame(frame) {
      if (!raw.writableEnded && !raw.destroyed) {
        raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    },
    onComplete() {
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    },
  });
  // The socket may have closed while a completed handle replayed
  // synchronously, before `unsubscribe` received its real function.
  if (raw.destroyed) unsubscribe();
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
      const session = await getSession(currentProjectId(), paths, req.params.id);
      return {
        messages: toHistory(file, paths.sandbox),
        contextUsage: session ? contextUsageForClient(session) ?? null : null,
      };
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
      if (format !== "md" && format !== "json" && format !== "zip") {
        reply.code(400);
        return { detail: "format must be md, json, or zip (PDF is exported client-side)" };
      }
      try {
        const projectId = currentProjectId();
        const entries = readNotebookEntries(req.params.id, projectId);
        const projectName = getProject(projectId)?.name ?? projectId;
        const attachment = (ext: string) =>
          reply.header(
            "Content-Disposition",
            `attachment; filename="lab-notebook-${req.params.id}.${ext}"`,
          );
        if (format === "json") {
          reply.header("Content-Type", "application/json; charset=utf-8");
          attachment("json");
          return { sessionId: req.params.id, projectName, entries };
        }
        if (format === "zip") {
          const { buffer } = buildNotebookZip(entries, {
            sessionId: req.params.id,
            projectName,
            sandboxRoot: activePaths().sandbox,
          });
          reply.type("application/zip");
          attachment("zip");
          return buffer;
        }
        const md = notebookToMarkdown(entries, { sessionId: req.params.id, projectName });
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        attachment("md");
        return md;
      } catch (exc) {
        reply.code(400);
        return { detail: (exc as Error).message };
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        reply.header("Cache-Control", "no-store");
        const { doc, mtime } = readNotebookAnnotations(req.params.id, currentProjectId());
        if (mtime) reply.header("Last-Modified", mtime.toUTCString());
        return doc;
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        const projectId = currentProjectId();
        const { mtime } = readNotebookAnnotations(req.params.id, projectId);
        if (mtime) {
          const precond = req.headers["if-unmodified-since"];
          if (precond) {
            const expected = new Date(String(precond)).getTime();
            if (!Number.isNaN(expected) && mtime.getTime() - expected > 1000) {
              reply.code(412);
              return { detail: "Sidecar modified; re-read and retry" };
            }
          }
        }
        const doc = normalizeNotebookAnnotations(req.body);
        const newMtime = writeNotebookAnnotations(req.params.id, doc, projectId);
        touchProject(projectId);
        reply.header("Last-Modified", newMtime.toUTCString());
        return { saved: req.params.id, count: doc.annotations.length };
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { model?: string } | null }>(
    "/sessions/:id/notebook/methods-draft",
    async (req, reply) => {
      try {
        return await runMethodsDraft(req.params.id, currentProjectId(), {
          model: req.body?.model,
        });
      } catch (err) {
        if (err instanceof MethodsDraftError) {
          reply.code(err.status);
          return err.status === 402
            ? { detail: "budget-exceeded", message: err.message }
            : { detail: "methods-draft-failed", message: err.message };
        }
        throw err;
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

  app.get<{ Params: { id: string } }>("/sessions/:id/run/state", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return runBroker.state(currentProjectId(), req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/sessions/:id/run/events",
    async (req, reply) => {
      const rawAfter = req.query.after;
      const after = rawAfter === undefined ? 0 : Number(rawAfter);
      if (!Number.isSafeInteger(after) || after < 0) {
        reply.code(400);
        return { detail: "after must be a non-negative integer" };
      }
      const handle = runBroker.get(currentProjectId(), req.params.id);
      if (!handle) {
        reply.code(404);
        return { detail: "No retained run for this session" };
      }
      streamRun(req, reply, handle, after);
    },
  );

  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const projectId = currentProjectId();
    // Mark first so an abort racing with pre-prompt model setup prevents that
    // detached owner from entering prompt() after session.abort() returns.
    runBroker.get(projectId, req.params.id)?.requestAbort();
    const session = await getSession(projectId, activePaths(), req.params.id);
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
      const sessionId = req.params.id;
      const runKey = `${projectId}:${sessionId}`;
      const retained = runBroker.get(projectId, sessionId);
      if (session.isStreaming || activeRuns.has(runKey) || (retained && !retained.isComplete)) {
        reply.code(409);
        return { detail: "Session is already streaming a response" };
      }

      const body = req.body ?? {};
      if (!body.message || !body.message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      const prompt = body.message;
      const parsedImages = parseRunImages(body.images);
      if ("error" in parsedImages) {
        reply.code(400);
        return { detail: parsedImages.error };
      }
      // This baseline remains valid through model/thinking setup because Pi
      // does not append conversation messages until prompt() starts.
      const historyFile = findSessionFile(paths, sessionId);
      const baseline = {
        messages: historyFile ? toHistory(historyFile, paths.sandbox) : [],
        contextUsage: contextUsageForClient(session) ?? null,
      };
      // No awaits between the guard above and this claim, so it is atomic.
      activeRuns.add(runKey);
      // One id per run invocation; notebook entries appended during this run
      // (lead tool + subagent harvest) are stamped with it. Cleared in the
      // owner cleanup so it covers every exit path.
      const runId = mintRunId();
      setSessionRunId(projectId, session.sessionId, runId);
      const handle = runBroker.start(projectId, sessionId, {
        runId,
        prompt,
        images: parsedImages.images.map(({ data, mimeType }) => ({ data, mimeType })),
        baseline,
      });
      // Publish immediately, before any awaited model setup, so refresh recovery
      // can discover the accepted run during that setup window.
      handle.publish({ type: "run_start", runId });
      // For a Fusion run we disable Pi's local tools for the turn (see below).
      // Remember the real active set so we can restore it in the finally; `null`
      // means "not a fusion run, nothing to restore".
      let savedToolNames: string[] | null = null;
      let detachedOwner = false;
      const log = req.log;
      const cleanup = () => {
        // Restore the local tool set disabled for a fusion run. No-op for
        // non-fusion runs (savedToolNames stays null).
        if (savedToolNames !== null) {
          session.setActiveToolsByName(savedToolNames);
          savedToolNames = null;
        }
        setSessionRunId(projectId, session.sessionId, null);
        activeRuns.delete(runKey);
      };
      try {
        // Stash this run's selected compute instance so the modal_run tool uses
        // it as the default when the agent doesn't name one ("local"/unset clears it).
        setSessionComputeTarget(projectId, session.sessionId, body.computeTarget ?? null);
        setSessionComputeOptions(
          projectId,
          session.sessionId,
          body.computeTarget ? body.computeOptions : null,
        );
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
            setFusionConfig(projectId, session.sessionId, body.fusionConfig ?? null);
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
            setFusionConfig(projectId, session.sessionId, null);
            handle.publish({
              type: "error",
              message: `Fusion model could not be prepared: ${(err as Error).message}`,
            });
            reply.code(400);
            return {
              detail: `Fusion model could not be prepared: ${(err as Error).message}`,
            };
          }
        } else {
          // Non-fusion run: clear any fusion config so the extension passes the
          // payload through untouched.
          setFusionConfig(projectId, session.sessionId, null);
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

        // Model selection can change the context window. Refresh the baseline
        // value and publish the configured model's usage before prompt().
        baseline.contextUsage = contextUsageForClient(session) ?? null;
        const publishContextUsage = () => {
          const frame = contextUsageFrame(contextUsageForClient(session));
          if (frame) handle.publish(frame);
        };
        publishContextUsage();

        // The detached task owns the Pi run and every finalizer. HTTP responses
        // below are observers only, so browser refresh/socket close cannot abort
        // or skip ledger/tool restoration. projectId/paths/sessionId are already
        // captured; no AsyncLocalStorage-backed project lookup occurs here.
        detachedOwner = true;
        void (async () => {
          let unsubscribePi: (() => void) | null = null;
          try {
            // Explicit POST /abort may have raced with awaited model setup.
            // In that case abort is authoritative and prompt must never start.
            if (handle.isAbortRequested) return;

            // Hard budget cap: refuse to run if the project has reached its limit.
            const budget = isBudgetExceeded(projectId);
            if (budget.exceeded) {
              handle.publish({
                type: "error",
                kind: "budget",
                message:
                  `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
                  `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project ` +
                  `settings and retry.`,
              });
              return;
            }

            // Usage tallied straight from turn_end events. getSessionStats() is
            // recomputed from the in-context messages, so auto-compaction mid-run
            // can shrink the cumulative stats and make the before/after delta lie
            // low; the per-turn events are immune to that.
            const turnTally = emptySnapshot();
            unsubscribePi = session.subscribe((ev) => {
              if (ev.type === "turn_end") {
                const usage = (ev.message as {
                  usage?: Parameters<typeof addTurnUsage>[1];
                }).usage;
                if (usage) addTurnUsage(turnTally, usage);
              }
              const frame = toClientFrame(ev, paths.sandbox);
              if (frame) handle.publish(frame);
              if (ev.type === "turn_end") publishContextUsage();
            });

            // errorMessage is sticky on the session; only report it if THIS run set it.
            const priorError = session.state.errorMessage;
            const before = snapshot(session);
            try {
              await session.prompt(
                prompt,
                parsedImages.images.length > 0 ? { images: parsedImages.images } : undefined,
              );
              // Surface a provider/agent error that didn't already stream as a
              // frame (e.g. auth failure with an empty assistant turn).
              const errorMessage = session.state.errorMessage;
              if (errorMessage && errorMessage !== priorError) {
                handle.publish({ type: "error", message: errorMessage });
              }
            } catch (err) {
              handle.publish({ type: "error", message: (err as Error).message });
            } finally {
              unsubscribePi();
              unsubscribePi = null;
              // Ledger in the finally: a run that threw mid-turn still spent real
              // tokens. The stats delta catches a partial turn that never reached
              // turn_end; the tally catches compaction — take the max of the two.
              try {
                const run = snapshotMax(snapshotDelta(before, snapshot(session)), turnTally);
                recordRun({
                  sessionId,
                  projectId,
                  model: session.model?.id ?? "unknown",
                  before: emptySnapshot(),
                  after: run,
                });
                const stats = session.getSessionStats();
                // `cost` is the session's full ledgered spend (subagents included,
                // restart/compaction-proof); `tokens` is Pi's in-context cumulative;
                // `runCost`/`runTokens` are the delta for THIS turn.
                publishContextUsage();
                handle.publish({
                  type: "cost",
                  cost: sessionCostSummary(sessionId, projectId).totalUsd,
                  tokens: stats.tokens,
                  runCost: run.costUsd,
                  runTokens: run.total,
                });
              } catch (err) {
                log.warn({ err }, "failed to ledger run cost");
              }
            }
          } catch (err) {
            log.error({ err }, "detached run failed");
            if (!handle.isComplete) {
              handle.publish({ type: "error", message: (err as Error).message });
            }
          } finally {
            unsubscribePi?.();
            if (!handle.isComplete) {
              handle.publish({ type: "done" });
              handle.complete();
            }
            cleanup();
          }
        })();

        // POST /run remains an SSE endpoint, now subscribed to the same replay
        // buffer used by reconnecting GET /run/events clients.
        streamRun(req, reply, handle);
      } catch (err) {
        if (!detachedOwner && !handle.isComplete) {
          handle.publish({ type: "error", message: (err as Error).message });
        }
        throw err;
      } finally {
        // Once handed off, the detached owner performs cleanup after Pi and
        // ledger finalization. Preparation failures still clean up here.
        if (!detachedOwner) {
          if (!handle.isComplete) {
            handle.publish({ type: "done" });
            handle.complete();
          }
          cleanup();
        }
      }
    },
  );
}
