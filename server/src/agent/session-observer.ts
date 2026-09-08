/**
 * Permanent per-session observer: turns work a Pi extension starts on its own
 * into first-class Kady runs.
 *
 * `POST /sessions/:id/run` only listens to a session while its own run is
 * live. pi-subagents, however, injects custom messages with `triggerTurn:
 * true` — a child's supervisor request, a scheduled run's completion notice —
 * and on an idle session Pi starts a full agent turn nobody observes, ledgers
 * or streams. This observer adopts such a turn: it claims the run, opens a
 * broker handle (`origin: "system"`) and hands it to the shared pipeline, so
 * it is streamed to a reconnecting tab, provenance-recorded, cost-ledgered and
 * abortable exactly like a user run. A custom message appended to an idle
 * session without a turn (e.g. a watchdog stalemate) is published as a short
 * `kind: "notice"` run so a connected tab sees it live.
 *
 * The listener stays synchronous: Pi awaits listeners, and `session.abort()`
 * waits for idle, so awaiting anything here would stall or deadlock the loop.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FastifyBaseLogger } from "fastify";
import type { ProjectPaths } from "../projects.ts";
import { billingForModel, type BillingContext } from "../cost/billing.ts";
import { contextUsageForClient, toClientFrame } from "./events.ts";
import {
  claimRun,
  executeRun,
  isRunClaimed,
  openRun,
  type OpenedRun,
  type PipelineSession,
} from "./run-pipeline.ts";
import { findSessionFile } from "./session-export.ts";
import { toHistory } from "./session-history.ts";
import { getModelRuntime } from "./session-registry.ts";

export type ObservedSession = PipelineSession & Pick<AgentSession, "abort">;

export interface SessionObserverContext {
  projectId: string;
  paths: ProjectPaths;
  session: ObservedSession;
  log?: Pick<FastifyBaseLogger, "warn" | "error">;
}

const FAIL_CLOSED_BILLING: BillingContext = {
  provider: "unknown",
  authType: "none",
  billingMode: "payg",
};

/** Attach the observer; returns a detach function (called before dispose). */
export function attachSessionObserver({
  projectId,
  paths,
  session,
  log = console,
}: SessionObserverContext): () => void {
  const sessionId = session.sessionId;
  // Pump(s) of an observer-owned run. Empty while no system run is active.
  const tap = new Set<(ev: AgentSessionEvent) => void>();
  let active: { settle(): void; fail(err: Error): void } | null = null;

  const publishNotice = (ev: AgentSessionEvent): void => {
    const frame = toClientFrame(ev, paths.sandbox);
    if (!frame) return; // `display: false`
    const claim = claimRun(projectId, sessionId);
    if (!claim) return;
    let opened: OpenedRun;
    try {
      opened = openRun(claim, {
        origin: "system",
        kind: "notice",
        reason: typeof frame.customType === "string" ? frame.customType : undefined,
        prompt: "",
        images: [],
        // The JSONL already holds this message: a reloading tab reads history
        // instead of replaying an empty baseline plus this frame.
        baseline: { messages: [], contextUsage: null },
        session,
      });
    } catch (err) {
      log.warn({ err }, "could not publish idle custom message");
      return;
    }
    opened.handle.publish(frame);
    opened.abandon();
  };

  const startSystemRun = (ev: AgentSessionEvent): void => {
    const claim = claimRun(projectId, sessionId);
    if (!claim) return;
    let opened: OpenedRun;
    try {
      // Read at agent_start: the triggering custom message is persisted only at
      // its message_end, so the baseline excludes it and the live frame carries
      // it — no duplicate.
      const file = findSessionFile(paths, sessionId);
      const baseline = {
        messages: file ? toHistory(file, paths.sandbox) : [],
        contextUsage: contextUsageForClient(session) ?? null,
      };
      opened = openRun(claim, {
        origin: "system",
        kind: "turn",
        prompt: "",
        images: [],
        baseline,
        session,
      });
    } catch (err) {
      claim.release();
      log.error({ err }, "could not adopt an extension-initiated turn");
      return;
    }
    const settled = new Promise<void>((resolve, reject) => {
      active = { settle: resolve, fail: reject };
    });
    const billing = session.model
      ? billingForModel(session.model, getModelRuntime()).catch(() => FAIL_CLOSED_BILLING)
      : Promise.resolve(FAIL_CLOSED_BILLING);
    void executeRun(opened, {
      session,
      paths,
      billing,
      subscribe: (listener) => {
        tap.add(listener);
        return () => tap.delete(listener);
      },
      // One _runAgentPrompt can emit several agent_start/agent_end pairs
      // (retries, post-compaction continuation); agent_settled is terminal.
      run: () => settled,
      budgetPolicy: "abort",
      // Runs in executeRun's async continuation, never inside the listener.
      onBudgetAbort: () => {
        void session.abort().catch((err) => log.warn({ err }, "budget abort failed"));
      },
      log,
    });
    // executeRun subscribed its pump synchronously; the tap was empty when this
    // event passed the top of the listener, so it is seen exactly once.
    for (const listener of tap) listener(ev);
  };

  const unsubscribe = session.subscribe((ev) => {
    for (const listener of tap) listener(ev);
    if (active) {
      if (ev.type === "agent_settled") {
        const current = active;
        active = null;
        current.settle();
      }
      return;
    }
    // A route-owned run: its own pump publishes; stay passive.
    if (isRunClaimed(projectId, sessionId)) return;
    if (ev.type === "message_start") {
      const message = ev.message as { role?: string };
      if (message.role === "custom" && !session.isStreaming) {
        publishNotice(ev);
        return;
      }
    }
    if (ev.type === "agent_settled" || ev.type === "message_end" || ev.type === "queue_update") {
      return;
    }
    // agent_start is the normal entry; any other event while streaming and
    // unclaimed means we are joining late (e.g. the claim was just released).
    if (ev.type === "agent_start" || session.isStreaming) startSystemRun(ev);
  });

  return () => {
    unsubscribe();
    if (active) {
      const current = active;
      active = null;
      // Fail the settled promise so executeRun finalizes the handle; otherwise
      // the session id stays 409-locked in the broker.
      current.fail(new Error("Session disposed during a system-initiated run"));
    }
    tap.clear();
  };
}
