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
import { contextUsageForClient } from "../agent/events.ts";
import { setFusionConfig } from "../agent/fusion-bridge.ts";
import {
  cancelInterviewsForSession,
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
import {
  assertModelAuthentication,
  ModelAuthenticationError,
  resolveModel,
} from "../agent/models.ts";
import { parseRunImages } from "../agent/prompt-images.ts";
import { readNotebookEntries } from "../agent/notebook-store.ts";
import { withNotebookArtifactHealth } from "../agent/notebook-artifacts.ts";
import { withNotebookPlanHistory } from "../agent/notebook-research.ts";
import { notebookToMarkdown } from "../agent/notebook-export.ts";
import { buildNotebookZip } from "../agent/notebook-zip.ts";
import {
  normalizeNotebookAnnotations,
  readNotebookAnnotations,
  writeNotebookAnnotations,
} from "../agent/notebook-annotations.ts";
import { MethodsDraftError, runMethodsDraft } from "../agent/methods-draft.ts";
import { runBroker, type RunHandle } from "../agent/run-broker.ts";
import {
  claimRun,
  executeRun,
  isRunClaimed,
  openRun,
  type OpenedRun,
} from "../agent/run-pipeline.ts";
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
  getModelRuntime,
  getSession,
  listSessions,
} from "../agent/session-registry.ts";
import { parseThinkingLevel } from "../agent/thinking.ts";
import { isBudgetExceeded, sessionCostSummary } from "../cost/ledger.ts";
import {
  billingCountsTowardBudget,
  billingForModel,
  type BillingContext,
} from "../cost/billing.ts";

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
      reply.header("Cache-Control", "no-store");
      const projectId = currentProjectId();
      return { entries: withNotebookPlanHistory(await withNotebookArtifactHealth(readNotebookEntries(req.params.id, projectId), projectId), projectId, req.params.id) };
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
        const entries = withNotebookPlanHistory(await withNotebookArtifactHealth(readNotebookEntries(req.params.id, projectId), projectId), projectId, req.params.id);
        reply.header("Cache-Control", "no-store");
        const projectName = getProject(projectId)?.name ?? projectId;
        // Pins, comments and standalone notes live in a sidecar. Leaving them
        // out made every export silently drop the user's own layer.
        const { doc: annotationsDoc } = readNotebookAnnotations(req.params.id, projectId);
        const annotations = annotationsDoc.annotations;
        const attachment = (ext: string) =>
          reply.header(
            "Content-Disposition",
            `attachment; filename="lab-notebook-${req.params.id}.${ext}"`,
          );
        if (format === "json") {
          reply.header("Content-Type", "application/json; charset=utf-8");
          attachment("json");
          return { sessionId: req.params.id, projectName, entries, annotations };
        }
        if (format === "zip") {
          const { buffer } = buildNotebookZip(entries, {
            sessionId: req.params.id,
            projectName,
            sandboxRoot: activePaths().sandbox,
            annotations,
          });
          reply.type("application/zip");
          attachment("zip");
          return buffer;
        }
        const md = notebookToMarkdown(entries, {
          sessionId: req.params.id,
          projectName,
          annotations,
        });
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
        const { doc, mtime, etag } = readNotebookAnnotations(req.params.id, currentProjectId());
        if (mtime) reply.header("Last-Modified", mtime.toUTCString());
        if (etag) reply.header("ETag", etag);
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
        const { mtime, etag } = readNotebookAnnotations(req.params.id, projectId);
        const ifMatch = req.headers["if-match"] ? String(req.headers["if-match"]) : null;
        const ifUnmodifiedSince = req.headers["if-unmodified-since"];
        if (ifMatch) {
          // Exact check. The Last-Modified fallback below can only compare
          // whole seconds, so a same-second edit would slip through it.
          if (ifMatch === "*" ? !etag : ifMatch !== etag) {
            reply.code(412);
            return { detail: "Sidecar modified; re-read and retry" };
          }
        } else if (ifUnmodifiedSince && mtime) {
          const since = new Date(String(ifUnmodifiedSince)).getTime();
          if (
            !Number.isNaN(since) &&
            Math.floor(mtime.getTime() / 1000) > Math.floor(since / 1000)
          ) {
            reply.code(412);
            return { detail: "Sidecar modified; re-read and retry" };
          }
        }
        const doc = normalizeNotebookAnnotations(req.body);
        const saved = writeNotebookAnnotations(req.params.id, doc, projectId);
        touchProject(projectId);
        reply.header("Last-Modified", saved.mtime.toUTCString());
        if (saved.etag) reply.header("ETag", saved.etag);
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

  // `?frames=0` returns metadata only (no replay buffer/baseline) so an idle
  // tab can poll cheaply for a run it did not start (system-initiated runs).
  app.get<{ Params: { id: string }; Querystring: { frames?: string } }>(
    "/sessions/:id/run/state",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const includeFrames = req.query.frames !== "0";
      return runBroker.state(currentProjectId(), req.params.id, { includeFrames });
    },
  );

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
    // Release any interview blocking the turn before aborting: a form still
    // waiting on user input would otherwise keep the run alive.
    cancelInterviewsForSession(projectId, req.params.id);
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
      const steeringBilling = session.model
        ? await billingForModel(session.model, getModelRuntime())
        : { provider: "unknown", authType: "none" as const, billingMode: "payg" as const };
      if (billingCountsTowardBudget(steeringBilling) && budget.exceeded) {
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
        const cleared = session.clearQueue();
        reply.code(409);
        return {
          detail: "Run ended before the message was delivered",
          reason: "not_streaming",
          // Hand every dropped message back so the client can restore them;
          // clearQueue also discards anything queued before this steer.
          restored: [...cleared.steering, ...cleared.followUp],
        };
      }
      return { ok: true, pending: [...session.getSteeringMessages()] };
    },
  );

  // Follow-up side-channel: queue a message that Pi delivers once the live
  // run has no more tool calls or steering messages, still inside the same
  // run (same SSE stream, same ledger row). Unlike steering it may carry
  // images. Same 409/403 contract as /steer.
  app.post<{ Params: { id: string }; Body: { message?: string; images?: unknown } }>(
    "/sessions/:id/follow-up",
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
      const parsedImages = parseRunImages(req.body?.images);
      if ("error" in parsedImages) {
        reply.code(400);
        return { detail: parsedImages.error };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      const budget = isBudgetExceeded(projectId);
      const followUpBilling = session.model
        ? await billingForModel(session.model, getModelRuntime())
        : { provider: "unknown", authType: "none" as const, billingMode: "payg" as const };
      if (billingCountsTowardBudget(followUpBilling) && budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      await session.followUp(
        message,
        parsedImages.images.length > 0 ? parsedImages.images : undefined,
      );
      if (!session.isStreaming) {
        const cleared = session.clearQueue();
        reply.code(409);
        return {
          detail: "Run ended before the message was delivered",
          reason: "not_streaming",
          restored: [...cleared.steering, ...cleared.followUp],
        };
      }
      return { ok: true, pending: [...session.getFollowUpMessages()] };
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
      const retained = runBroker.get(projectId, sessionId);
      if (
        session.isStreaming ||
        isRunClaimed(projectId, sessionId) ||
        (retained && !retained.isComplete)
      ) {
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
      // Claim before the first awaited auth check so concurrent requests cannot
      // both pass the run guard. Preflight failures release the claim below.
      const claim = claimRun(projectId, session.sessionId);
      if (!claim) {
        reply.code(409);
        return { detail: "Session is already streaming a response" };
      }
      const isFusion = Boolean(body.model && body.model.startsWith("fusion/"));
      let requestedModel: ReturnType<typeof resolveModel>;
      let runBilling: BillingContext;
      try {
        requestedModel = body.model
          ? resolveModel(body.model, getModelRegistry(), body.fusionConfig)
          : session.model ?? resolveModel(undefined, getModelRegistry());
        await assertModelAuthentication(requestedModel, getModelRuntime());
        runBilling = await billingForModel(requestedModel, getModelRuntime());
      } catch (error) {
        claim.release();
        reply.code(error instanceof ModelAuthenticationError ? 401 : 400);
        return {
          detail:
            error instanceof Error ? error.message : "The selected model could not be prepared",
          reason:
            error instanceof ModelAuthenticationError ? "provider_not_connected" : "invalid_model",
        };
      }
      // For a Fusion run we disable Pi's local tools for the turn (see below).
      // Remember the real active set so we can restore it in cleanup; `null`
      // means "not a fusion run, nothing to restore".
      let savedToolNames: string[] | null = null;
      let opened: OpenedRun;
      try {
        opened = openRun(claim, {
          origin: "user",
          kind: "turn",
          prompt,
          images: parsedImages.images.map(({ data, mimeType }) => ({ data, mimeType })),
          baseline,
          session,
          onCleanup: () => {
            if (savedToolNames !== null) {
              session.setActiveToolsByName(savedToolNames);
              savedToolNames = null;
            }
          },
        });
      } catch (err) {
        // openRun released the claim; without that the tab would stay
        // permanently 409-locked until the process restarts.
        reply.code(500);
        return { detail: (err as Error).message };
      }
      const { handle } = opened;
      try {
        // Stash this run's selected compute instance so the modal_run tool uses
        // it as the default when the agent doesn't name one ("local"/unset clears it).
        setSessionComputeTarget(projectId, session.sessionId, body.computeTarget ?? null);
        setSessionComputeOptions(
          projectId,
          session.sessionId,
          body.computeTarget ? body.computeOptions : null,
        );
        if (isFusion) {
          // Fusion is load-bearing for the spend cap: the cost-bearing Model
          // (priced from the panel sum) and the body-rewrite must be applied
          // together for THIS run. If resolution fails (e.g. catalogue priced
          // no panel model), do NOT swallow it and run at the prior model's
          // cost — abort, since the body would still be rewritten to fusion.
          try {
            await session.setModel(requestedModel);
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
            // Restored in cleanup so non-fusion runs keep all tools.
            savedToolNames = session.getActiveToolNames();
            session.setActiveToolsByName([]);
          } catch (err) {
            // Make sure no stale fusion config rewrites this run's body.
            // (The outer finally abandons the run and releases the claim.)
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
              await session.setModel(requestedModel);
            } catch (err) {
              handle.publish({
                type: "error",
                message: `Model could not be selected: ${(err as Error).message}`,
              });
              reply.code(400);
              return {
                detail: `Model could not be selected: ${(err as Error).message}`,
              };
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
        opened.publishContextUsage();

        // The detached task owns the Pi run and every finalizer. HTTP responses
        // below are observers only, so browser refresh/socket close cannot abort
        // or skip ledger/tool restoration. projectId/paths/sessionId are already
        // captured; no AsyncLocalStorage-backed project lookup occurs here.
        void executeRun(opened, {
          session,
          paths,
          billing: runBilling,
          budgetPolicy: "refuse",
          log: req.log,
          run: () =>
            session.prompt(
              prompt,
              parsedImages.images.length > 0 ? { images: parsedImages.images } : undefined,
            ),
        });

        // POST /run remains an SSE endpoint, now subscribed to the same replay
        // buffer used by reconnecting GET /run/events clients.
        streamRun(req, reply, handle);
      } catch (err) {
        opened.abandon(err as Error);
        throw err;
      } finally {
        // Once handed off, the detached owner performs cleanup after Pi and
        // ledger finalization. Preparation failures still clean up here.
        opened.abandon();
      }
    },
  );
}
