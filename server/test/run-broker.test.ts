import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunAlreadyActiveError,
  RunBroker,
  type RunMetadata,
  type SequencedClientFrame,
} from "../src/agent/run-broker.ts";

function metadata(runId = "run-1"): RunMetadata {
  return {
    runId,
    prompt: "analyze this",
    images: [],
    baseline: { messages: [], contextUsage: null },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RunBroker", () => {
  it("sequences frames monotonically and exposes the replay state", () => {
    const broker = new RunBroker();
    const handle = broker.start("p1", "s1", metadata());

    expect(handle.publish({ type: "run_start", runId: "run-1" }).seq).toBe(1);
    expect(handle.publish({ type: "text_delta", delta: "hello" }).seq).toBe(2);

    expect(broker.state("p1", "s1")).toMatchObject({
      status: "running",
      run: {
        runId: "run-1",
        prompt: "analyze this",
        lastSeq: 2,
        frames: [
          { type: "run_start", seq: 1 },
          { type: "text_delta", delta: "hello", seq: 2 },
        ],
      },
    });
  });

  it("replays after a cursor and hands off synchronously to live frames", () => {
    const broker = new RunBroker();
    const handle = broker.start("p1", "s1", metadata());
    handle.publish({ type: "text_delta", delta: "one" });
    handle.publish({ type: "text_delta", delta: "two" });

    const received: number[] = [];
    handle.subscribe({
      after: 1,
      onFrame(frame) {
        received.push(frame.seq);
        // Exercise a re-entrant publish at the replay/live boundary.
        if (frame.seq === 2) handle.publish({ type: "text_delta", delta: "three" });
      },
    });

    expect(received).toEqual([2, 3]);
  });

  it("fans out independently and lets one observer unsubscribe", () => {
    const broker = new RunBroker();
    const handle = broker.start("p1", "s1", metadata());
    const first: SequencedClientFrame[] = [];
    const second: SequencedClientFrame[] = [];
    const unsubscribeFirst = handle.subscribe({ onFrame: (frame) => first.push(frame) });
    handle.subscribe({ onFrame: (frame) => second.push(frame) });

    handle.publish({ type: "text_delta", delta: "a" });
    unsubscribeFirst();
    handle.publish({ type: "text_delta", delta: "b" });

    expect(first.map((frame) => frame.seq)).toEqual([1]);
    expect(second.map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it("preserves fanout order across re-entrant publishes", () => {
    const broker = new RunBroker();
    const handle = broker.start("p1", "s1", metadata());
    const first: number[] = [];
    const second: number[] = [];
    handle.subscribe({
      onFrame(frame) {
        first.push(frame.seq);
        if (frame.seq === 1) handle.publish({ type: "text_delta", delta: "nested" });
      },
    });
    handle.subscribe({ onFrame: (frame) => second.push(frame.seq) });

    handle.publish({ type: "text_delta", delta: "outer" });

    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
  });

  it("marks completion after replay and rejects a second active run", () => {
    const broker = new RunBroker();
    const handle = broker.start("p1", "s1", metadata());
    expect(() => broker.start("p1", "s1", metadata("run-2"))).toThrow(
      RunAlreadyActiveError,
    );
    handle.publish({ type: "done" });
    handle.complete();

    const received: number[] = [];
    let completed = 0;
    handle.subscribe({
      onFrame: (frame) => received.push(frame.seq),
      onComplete: () => completed++,
    });

    expect(received).toEqual([1]);
    expect(completed).toBe(1);
    expect(broker.state("p1", "s1").status).toBe("complete");
    expect(() => handle.publish({ type: "text_delta", delta: "late" })).toThrow(
      /completed run/,
    );
  });

  it("lists project-scoped active runs and resolves completion waiters", async () => {
    const broker = new RunBroker();
    const p1 = broker.start("p1", "s1", metadata("p1-run"));
    const p2 = broker.start("p2", "s1", metadata("p2-run"));
    const completed = vi.fn();
    void p1.waitForCompletion().then(completed);

    expect(broker.activeForProject("p1")).toEqual([p1]);
    p1.publish({ type: "done" });
    p1.complete();
    await p1.waitForCompletion();

    expect(completed).toHaveBeenCalledOnce();
    expect(broker.activeForProject("p1")).toEqual([]);
    expect(broker.activeForProject("p2")).toEqual([p2]);
    broker.clear();
  });

  it("summarizes retained run outcomes without copying replay frames", () => {
    const broker = new RunBroker();
    const running = broker.start("p1", "running", metadata("running"));
    const failed = broker.start("p1", "failed", metadata("failed"));
    failed.publish({ type: "error", message: "provider failed" });
    failed.complete();
    const blocked = broker.start("p1", "blocked", metadata("blocked"));
    blocked.publish({ type: "error", kind: "budget", message: "budget exceeded" });
    blocked.complete();

    expect(broker.activityForProject("p1")).toEqual([
      { sessionId: "running", state: "running" },
      { sessionId: "failed", state: "error" },
      { sessionId: "blocked", state: "blocked" },
    ]);

    running.publish({ type: "done" });
    running.complete();
    expect(broker.activityForProject("p1")[0]).toEqual({
      sessionId: "running",
      state: "done",
    });
    broker.clear();
  });

  it("retains completed handles briefly without expiring active handles", () => {
    vi.useFakeTimers();
    const broker = new RunBroker({ completedRetentionMs: 1_000 });
    const active = broker.start("p1", "active", metadata("active"));
    const completed = broker.start("p1", "complete", metadata("complete"));
    completed.publish({ type: "done" });
    completed.complete();

    vi.advanceTimersByTime(1_001);

    expect(broker.get("p1", "active")).toBe(active);
    expect(broker.state("p1", "complete")).toEqual({ status: "none" });
    broker.clear();
  });

  it("bounds retained completed handles", () => {
    const broker = new RunBroker({
      completedRetentionMs: 60_000,
      maxCompletedHandles: 2,
    });
    for (const id of ["s1", "s2", "s3"]) {
      const handle = broker.start("p1", id, metadata(id));
      handle.publish({ type: "done" });
      handle.complete();
    }

    expect(broker.state("p1", "s1").status).toBe("none");
    expect(broker.state("p1", "s2").status).toBe("complete");
    expect(broker.state("p1", "s3").status).toBe("complete");
    broker.clear();
  });
});
