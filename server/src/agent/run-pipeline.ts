/**
 * The per-run pipeline shared by `POST /sessions/:id/run` (user runs) and the
 * session observer (system-initiated runs — turns an extension started while
 * no Kady run was active, e.g. a subagent's supervisor request or a scheduled
 * run's completion notice).
 *
 * Three phases keep the route's two load-bearing orderings intact:
 *
 *   1. `claimRun`   — synchronous, before the first `await`, so two concurrent
 *                     POSTs cannot both pass the run guard;
 *   2. `openRun`    — synchronous: mint the run id, create the broker handle,
 *                     publish `run_start` BEFORE any awaited model setup so a
 *                     refreshing tab can rediscover the accepted run;
 *   3. `executeRun` — the detached owner: pump Pi events into the handle,
 *                     record provenance, ledger cost, publish `cost`/`done`,
 *                     then release the claim. HTTP responses only observe it.
 *
 * `executeRun` subscribes its event pump before its first `await`, so a caller
 * that already saw `agent_start` (the observer) can re-deliver that event and
 * miss nothing.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FastifyBaseLogger } from "fastify";
import type { ProjectPaths } from "../projects.ts";
import {
  contextUsageForClient,
  contextUsageFrame,
  toClientFrame,
  type ClientFrame,
} from "./events.ts";
import { explainProviderRefusal } from "./model-refusal.ts";
import { modelReference } from "./models.ts";
import { mintRunId, setSessionRunId } from "./run-ids.ts";
import {
  runBroker,
  type RunBaseline,
  type RunHandle,
  type RunKind,
  type RunOrigin,
} from "./run-broker.ts";
import { pinSession, unpinSession } from "./session-registry.ts";
import { ProvenanceRecorder } from "../provenance/recorder.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
  trackInFlightRun,
  untrackInFlightRun,
  type CostSnapshot,
} from "../cost/ledger.ts";
import { billingCountsTowardBudget, type BillingContext } from "../cost/billing.ts";

/** The slice of AgentSession the pipeline touches (fakes implement exactly this). */
export type PipelineSession = Pick<
  AgentSession,
  | "sessionId"
  | "subscribe"
  | "getSessionStats"
  | "getContextUsage"
  | "messages"
  | "model"
  | "isStreaming"
> & { state: { errorMessage?: string } };

export function snapshot(session: Pick<PipelineSession, "getSessionStats">): CostSnapshot {
  const s = session.getSessionStats();
  return {
    costUsd: s.cost,
    input: s.tokens.input,
    output: s.tokens.output,
    cacheRead: s.tokens.cacheRead,
    total: s.tokens.total,
  };
}

// Sessions with a run in flight, claimed synchronously. `session.isStreaming`
// flips true only after awaits inside prompt(), so concurrent POSTs could
// otherwise both pass the guard and the loser's close handler would abort the
// winner's live turn. The key doubles as the in-flight budget tracking key.
const activeRuns = new Set<string>();
const runKeyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

export interface RunClaim {
  readonly projectId: string;
  readonly sessionId: string;
  readonly key: string;
  /** Idempotent: unpins the session and frees the claim. */
  release(): void;
}

/**
 * Claim the session for one run. Returns null when a run is already claimed.
 * Pins the session for the whole claim (not just while streaming): another tab
 * opening during model setup could otherwise evict it out from under the run.
 */
export function claimRun(projectId: string, sessionId: string): RunClaim | null {
  const key = runKeyFor(projectId, sessionId);
  if (activeRuns.has(key)) return null;
  activeRuns.add(key);
  pinSession(projectId, sessionId);
  let released = false;
  return {
    projectId,
    sessionId,
    key,
    release() {
      if (released) return;
      released = true;
      unpinSession(projectId, sessionId);
      activeRuns.delete(key);
    },
  };
}

export function isRunClaimed(projectId: string, sessionId: string): boolean {
  return activeRuns.has(runKeyFor(projectId, sessionId));
}

export interface OpenRunOptions {
  origin: RunOrigin;
  kind: RunKind;
  /** For system runs: the custom message type that started it, when known. */
  reason?: string;
  prompt: string;
  images: { data: string; mimeType: string }[];
  baseline: RunBaseline;
  session: Pick<PipelineSession, "getContextUsage" | "messages">;
  runId?: string;
  /** Runs first in cleanup on every exit path (route: restore fusion tool set). */
  onCleanup?: () => void;
}

export interface OpenedRun {
  readonly handle: RunHandle;
  readonly runId: string;
  readonly claim: RunClaim;
  /** Publish the session's current context usage (call after model setup). */
  publishContextUsage(): void;
  /**
   * Preparation failed before the run was handed to `executeRun`: publish the
   * error (if any) and `done`, complete the handle, run cleanup, release the
   * claim. No-op once `executeRun` owns the run.
   */
  abandon(error?: Error): void;
}

class OpenedRunImpl implements OpenedRun {
  handedOff = false;
  constructor(
    readonly handle: RunHandle,
    readonly runId: string,
    readonly claim: RunClaim,
    private readonly session: Pick<PipelineSession, "getContextUsage" | "messages">,
    private readonly onCleanup: (() => void) | undefined,
  ) {}

  publishContextUsage(): void {
    if (this.handle.isComplete) return;
    const frame = contextUsageFrame(contextUsageForClient(this.session));
    if (frame) this.handle.publish(frame);
  }

  cleanup(): void {
    try {
      this.onCleanup?.();
    } finally {
      setSessionRunId(this.claim.projectId, this.claim.sessionId, null);
      // Runs after the ledger row is written (executeRun's inner finally), so
      // the run's spend is never invisible to a concurrent admission.
      untrackInFlightRun(this.claim.key);
      this.claim.release();
    }
  }

  abandon(error?: Error): void {
    if (this.handedOff) return;
    // Route code calls abandon() from both a catch and a finally; only the
    // first call finalizes.
    this.handedOff = true;
    if (error && !this.handle.isComplete) {
      this.handle.publish({ type: "error", message: error.message });
    }
    if (!this.handle.isComplete) {
      this.handle.publish({ type: "done" });
      this.handle.complete();
    }
    this.cleanup();
  }
}

/**
 * Mint the run id, register the broker handle and publish `run_start`. All
 * synchronous. On failure the claim is released (the tab would otherwise stay
 * 409-locked until the process restarts) and the error is rethrown.
 */
export function openRun(claim: RunClaim, opts: OpenRunOptions): OpenedRun {
  // One id per run invocation; notebook entries appended during this run (lead
  // tool + subagent harvest) are stamped with it. Cleared in cleanup so it
  // covers every exit path.
  const runId = opts.runId ?? mintRunId();
  let handle: RunHandle;
  try {
    setSessionRunId(claim.projectId, claim.sessionId, runId);
    handle = runBroker.start(claim.projectId, claim.sessionId, {
      runId,
      prompt: opts.prompt,
      images: opts.images,
      baseline: opts.baseline,
      origin: opts.origin,
      kind: opts.kind,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    // Publish immediately, before any awaited model setup, so refresh recovery
    // can discover the accepted run during that setup window.
    handle.publish({
      type: "run_start",
      runId,
      origin: opts.origin,
      kind: opts.kind,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  } catch (err) {
    setSessionRunId(claim.projectId, claim.sessionId, null);
    claim.release();
    throw err;
  }
  return new OpenedRunImpl(handle, runId, claim, opts.session, opts.onCleanup);
}

export interface ExecuteRunOptions {
  session: PipelineSession;
  paths: ProjectPaths;
  /** May be a promise for system runs (billing resolved while the pump is live). */
  billing: BillingContext | Promise<BillingContext>;
  /** Event source; defaults to `session.subscribe`. The observer feeds a tap. */
  subscribe?: (listener: (ev: AgentSessionEvent) => void) => () => void;
  /** The work: `session.prompt(...)` for user runs; a promise settled on
   *  `agent_settled` for system runs. */
  run: () => Promise<void>;
  /**
   * Over the project cap: `refuse` publishes the budget error and never calls
   * `run` (user runs); `abort` publishes it, calls `onBudgetAbort` and still
   * awaits `run` so an already-started turn is observed to its aborted end
   * and ledgered (system runs).
   */
  budgetPolicy: "refuse" | "abort";
  onBudgetAbort?: () => void;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

const FAIL_CLOSED_BILLING: BillingContext = {
  provider: "unknown",
  authType: "none",
  billingMode: "payg",
};

/**
 * Own the run to completion. Never rejects: every failure is published as an
 * `error` frame and the handle is always completed and cleaned up.
 */
export async function executeRun(opened: OpenedRun, opts: ExecuteRunOptions): Promise<void> {
  const impl = opened as OpenedRunImpl;
  impl.handedOff = true;
  const { handle, runId, claim } = opened;
  const { projectId, sessionId } = claim;
  const { session, paths, log } = opts;
  let unsubscribePi: (() => void) | null = null;
  try {
    // Usage tallied straight from turn_end events. getSessionStats() is
    // recomputed from the in-context messages, so auto-compaction mid-run can
    // shrink the cumulative stats and make the before/after delta lie low; the
    // per-turn events are immune to that.
    const turnTally = emptySnapshot();
    // Observational provenance: binds each tool call to the sandbox files it
    // actually read and wrote. Constructed before the first model round-trip so
    // its baseline sandbox walk overlaps it.
    const provenance = new ProvenanceRecorder({
      projectId,
      sessionId,
      sandboxRoot: paths.sandbox,
      runId,
      getModel: () => (session.model ? modelReference(session.model) : undefined),
      onError: (err) => log.warn({ err }, "provenance recorder step failed"),
    });
    // A provider refusal reaches the client as an opaque "Provider
    // finish_reason: content_filter". Attach what to do about it, naming the
    // enabled skills known to cause it — the classifier reads the system
    // prompt, so the user cannot find the cause by rereading what they typed.
    const withRefusalGuidance = (frame: ClientFrame): ClientFrame =>
      frame.type === "error" && typeof frame.message === "string"
        ? {
            ...frame,
            message: explainProviderRefusal(frame.message, {
              projectId,
              modelRef: session.model ? modelReference(session.model) : undefined,
            }),
          }
        : frame;
    // Subscribed before the first await: a system run's caller re-delivers the
    // `agent_start` it already saw right after this call returns.
    const subscribe = opts.subscribe ?? ((l) => session.subscribe(l));
    unsubscribePi = subscribe((ev) => {
      provenance.observe(ev);
      if (ev.type === "turn_end") {
        const usage = (ev.message as { usage?: Parameters<typeof addTurnUsage>[1] }).usage;
        if (usage) addTurnUsage(turnTally, usage);
      }
      if (ev.type === "message_start" && handle.origin === "system") {
        const message = ev.message as { role?: string; customType?: string };
        if (message.role === "custom" && message.customType) handle.setReason(message.customType);
      }
      const frame = toClientFrame(ev, paths.sandbox);
      if (frame && !handle.isComplete) handle.publish(withRefusalGuidance(frame));
      if (ev.type === "turn_end") opened.publishContextUsage();
    });

    // errorMessage is sticky on the session; only report it if THIS run set it.
    const priorError = session.state.errorMessage;
    const before = snapshot(session);

    let billing: BillingContext;
    try {
      billing = await opts.billing;
    } catch (err) {
      log.warn({ err }, "billing resolution failed; counting the run toward the cap");
      billing = FAIL_CLOSED_BILLING;
    }
    // Publish this run's live spend so a concurrent run in another tab is
    // admitted against what we are actually spending, not against the ledger
    // total from before this run started.
    if (billingCountsTowardBudget(billing)) {
      trackInFlightRun(claim.key, projectId, () =>
        Math.max(0, snapshot(session).costUsd - before.costUsd),
      );
    }

    // Explicit POST /abort may have raced with awaited model setup. In that
    // case abort is authoritative and prompt must never start.
    let refused = handle.isAbortRequested;
    if (!refused && billingCountsTowardBudget(billing)) {
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
        if (opts.budgetPolicy === "refuse") refused = true;
        else opts.onBudgetAbort?.();
      }
    }

    if (!refused) {
      try {
        await opts.run();
        // Surface a provider/agent error that didn't already stream as a frame
        // (e.g. auth failure with an empty assistant turn).
        const errorMessage = session.state.errorMessage;
        if (errorMessage && errorMessage !== priorError && !handle.isComplete) {
          handle.publish(withRefusalGuidance({ type: "error", message: errorMessage }));
        }
      } catch (err) {
        if (!handle.isComplete) handle.publish({ type: "error", message: (err as Error).message });
      } finally {
        unsubscribePi();
        unsubscribePi = null;
        // Drain queued provenance scans before the terminal frames go out, so a
        // client that reads provenance on `done` sees a complete file.
        try {
          await provenance.flush();
        } catch (err) {
          log.warn({ err }, "failed to flush provenance");
        }
        // Ledger in the finally: a run that threw mid-turn still spent real
        // tokens. The stats delta catches a partial turn that never reached
        // turn_end; the tally catches compaction — take the max of the two.
        try {
          const run = snapshotMax(snapshotDelta(before, snapshot(session)), turnTally);
          const entry = recordRun({
            sessionId,
            projectId,
            model: session.model ? modelReference(session.model) : "unknown",
            before: emptySnapshot(),
            after: run,
            billing,
          });
          const stats = session.getSessionStats();
          // `cost` is the session's full ledgered spend (subagents included,
          // restart/compaction-proof); `tokens` is Pi's in-context cumulative;
          // `runCost`/`runTokens` are the delta for THIS turn.
          opened.publishContextUsage();
          if (!handle.isComplete) {
            handle.publish({
              type: "cost",
              cost: sessionCostSummary(sessionId, projectId).totalUsd,
              tokens: stats.tokens,
              runCost: entry?.costUsd ?? 0,
              runTokens: run.total,
              runBillingMode: billing.billingMode,
              runProvider: billing.provider,
              ...(entry?.listPriceUsd !== undefined ? { runListPriceUsd: entry.listPriceUsd } : {}),
            });
          }
        } catch (err) {
          log.warn({ err }, "failed to ledger run cost");
        }
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
    impl.cleanup();
  }
}
