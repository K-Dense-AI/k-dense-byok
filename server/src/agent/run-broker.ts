/**
 * In-memory broker for one live run per project/session.
 *
 * A run is owned by the server, not by whichever HTTP connection happened to
 * start or observe it. Every client frame receives a monotonically increasing
 * sequence number and remains replayable while the run is active. Completed
 * handles stay around briefly so a state request followed by an events request
 * cannot fall into a completion race.
 */
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ClientFrame } from "./events.ts";
import type { HistoryMessage } from "./session-history.ts";

export type SequencedClientFrame = ClientFrame & { seq: number };

export interface RunBaseline {
  messages: HistoryMessage[];
  contextUsage: ContextUsage | null;
}

export interface RunMetadata {
  runId: string;
  prompt: string;
  images: { data: string; mimeType: string }[];
  baseline: RunBaseline;
}

export interface RunState {
  status: "none" | "running" | "complete";
  run?: RunMetadata & {
    frames: SequencedClientFrame[];
    lastSeq: number;
  };
}

export type RunActivityState = "running" | "done" | "error" | "blocked";

export interface RunActivity {
  sessionId: string;
  state: RunActivityState;
}

export interface RunSubscription {
  after?: number;
  onFrame: (frame: SequencedClientFrame) => void;
  onComplete?: () => void;
}

interface Subscriber extends Required<Pick<RunSubscription, "onFrame">> {
  onComplete?: () => void;
  cursor: number;
  replaying: boolean;
  pending: SequencedClientFrame[];
  closed: boolean;
}

export class RunAlreadyActiveError extends Error {
  constructor() {
    super("Session already has an active run");
    this.name = "RunAlreadyActiveError";
  }
}

export class RunHandle {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly images: { data: string; mimeType: string }[];
  readonly baseline: RunBaseline;

  private readonly frames: SequencedClientFrame[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly dispatchQueue: SequencedClientFrame[] = [];
  private readonly onCompleted: (handle: RunHandle) => void;
  private nextSeq = 1;
  private completed = false;
  private abortRequested = false;
  private failure: "error" | "blocked" | null = null;
  private dispatching = false;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;

  constructor(
    projectId: string,
    sessionId: string,
    metadata: RunMetadata,
    onCompleted: (handle: RunHandle) => void,
  ) {
    this.projectId = projectId;
    this.sessionId = sessionId;
    this.runId = metadata.runId;
    this.prompt = metadata.prompt;
    this.images = metadata.images;
    this.baseline = metadata.baseline;
    this.onCompleted = onCompleted;
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  get isComplete(): boolean {
    return this.completed;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get isAbortRequested(): boolean {
    return this.abortRequested;
  }

  get activityState(): RunActivityState {
    if (this.failure) return this.failure;
    return this.completed ? "done" : "running";
  }

  requestAbort(): void {
    this.abortRequested = true;
  }

  waitForCompletion(): Promise<void> {
    return this.completion;
  }

  publish(frame: ClientFrame): SequencedClientFrame {
    if (this.completed) {
      throw new Error(`Cannot publish to completed run ${this.runId}`);
    }
    if (frame.type === "error") {
      this.failure = frame.kind === "budget" ? "blocked" : "error";
    }
    const sequenced = { ...frame, seq: this.nextSeq++ } as SequencedClientFrame;
    this.frames.push(sequenced);
    this.dispatchQueue.push(sequenced);
    if (!this.dispatching) {
      this.dispatching = true;
      try {
        for (const queued of this.dispatchQueue) {
          for (const subscriber of this.subscribers) {
            if (subscriber.closed || queued.seq <= subscriber.cursor) continue;
            if (subscriber.replaying) {
              subscriber.pending.push(queued);
            } else {
              this.deliver(subscriber, queued);
            }
          }
        }
      } finally {
        this.dispatchQueue.length = 0;
        this.dispatching = false;
      }
    }
    return sequenced;
  }

  /**
   * Replay every frame after `after`, then remain subscribed to live frames.
   * The entire handoff is synchronous, so no frame can land between replay and
   * live subscription.
   */
  subscribe(subscription: RunSubscription): () => void {
    const rawAfter = subscription.after ?? 0;
    const subscriber: Subscriber = {
      onFrame: subscription.onFrame,
      onComplete: subscription.onComplete,
      cursor: Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0,
      replaying: true,
      pending: [],
      closed: false,
    };
    this.subscribers.add(subscriber);

    for (const frame of this.frames) {
      if (subscriber.closed) break;
      if (frame.seq > subscriber.cursor) this.deliver(subscriber, frame);
    }
    subscriber.replaying = false;
    for (const frame of subscriber.pending) {
      if (subscriber.closed) break;
      if (frame.seq > subscriber.cursor) this.deliver(subscriber, frame);
    }
    subscriber.pending.length = 0;

    if (this.completed && !subscriber.closed) {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
      this.notifyComplete(subscriber);
    }

    return () => {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    };
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      this.notifyComplete(subscriber);
    }
    this.subscribers.clear();
    try {
      this.onCompleted(this);
    } finally {
      this.resolveCompletion();
    }
  }

  state(): RunState {
    return {
      status: this.completed ? "complete" : "running",
      run: {
        runId: this.runId,
        prompt: this.prompt,
        images: this.images,
        baseline: this.baseline,
        frames: [...this.frames],
        lastSeq: this.lastSeq,
      },
    };
  }

  private deliver(subscriber: Subscriber, frame: SequencedClientFrame): void {
    subscriber.cursor = frame.seq;
    try {
      subscriber.onFrame(frame);
    } catch {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    }
  }

  private notifyComplete(subscriber: Subscriber): void {
    try {
      subscriber.onComplete?.();
    } catch {
      // A disconnected observer must never affect the owned run.
    }
  }
}

export interface RunBrokerOptions {
  completedRetentionMs?: number;
  maxCompletedHandles?: number;
}

export const DEFAULT_COMPLETED_RETENTION_MS = 30_000;
export const DEFAULT_MAX_COMPLETED_HANDLES = 100;

export class RunBroker {
  private readonly handles = new Map<string, RunHandle>();
  private readonly completedKeys = new Set<string>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly completedRetentionMs: number;
  private readonly maxCompletedHandles: number;

  constructor(options: RunBrokerOptions = {}) {
    this.completedRetentionMs =
      options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
    this.maxCompletedHandles =
      options.maxCompletedHandles ?? DEFAULT_MAX_COMPLETED_HANDLES;
  }

  start(projectId: string, sessionId: string, metadata: RunMetadata): RunHandle {
    const key = keyFor(projectId, sessionId);
    const existing = this.handles.get(key);
    if (existing && !existing.isComplete) throw new RunAlreadyActiveError();
    if (existing) this.remove(key, existing);

    const handle = new RunHandle(projectId, sessionId, metadata, (completed) => {
      this.retainCompleted(key, completed);
    });
    this.handles.set(key, handle);
    return handle;
  }

  get(projectId: string, sessionId: string): RunHandle | undefined {
    return this.handles.get(keyFor(projectId, sessionId));
  }

  activeForProject(projectId: string): RunHandle[] {
    return [...this.handles.values()].filter(
      (handle) => handle.projectId === projectId && !handle.isComplete,
    );
  }

  activityForProject(projectId: string): RunActivity[] {
    return [...this.handles.values()]
      .filter((handle) => handle.projectId === projectId)
      .map((handle) => ({
        sessionId: handle.sessionId,
        state: handle.activityState,
      }));
  }

  state(projectId: string, sessionId: string): RunState {
    return this.get(projectId, sessionId)?.state() ?? { status: "none" };
  }

  /** Primarily for test/process cleanup. Active handles are simply forgotten. */
  clear(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.completedKeys.clear();
    this.handles.clear();
  }

  private retainCompleted(key: string, handle: RunHandle): void {
    if (this.handles.get(key) !== handle) return;
    this.completedKeys.delete(key);
    this.completedKeys.add(key);

    const priorTimer = this.expiryTimers.get(key);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(() => this.remove(key, handle), this.completedRetentionMs);
    timer.unref?.();
    this.expiryTimers.set(key, timer);

    while (this.completedKeys.size > this.maxCompletedHandles) {
      const oldest = this.completedKeys.values().next().value as string | undefined;
      if (oldest === undefined) break;
      const oldestHandle = this.handles.get(oldest);
      if (oldestHandle?.isComplete) this.remove(oldest, oldestHandle);
      else this.completedKeys.delete(oldest);
    }
  }

  private remove(key: string, expected: RunHandle): void {
    if (this.handles.get(key) !== expected) return;
    this.handles.delete(key);
    this.completedKeys.delete(key);
    const timer = this.expiryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(key);
  }
}

const keyFor = (projectId: string, sessionId: string) => `${projectId}\0${sessionId}`;

export const runBroker = new RunBroker();
