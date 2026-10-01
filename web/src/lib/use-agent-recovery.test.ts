import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as projects from "@/lib/projects";
import { RUN_RECONNECT_MS, useAgent, type AgentFrame } from "@/lib/use-agent";
import { SESSION_RESTORE_RETRY_MS, useSessionRestore } from "@/lib/use-session-restore";

const opening: AgentFrame[] = [
  { type: "run_start", runId: "run-1", seq: 1 },
  { type: "text_delta", delta: "hel", seq: 2 },
];
function stream(frames: AgentFrame[], error = false): Response {
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) {
      if (error) controller.error(new TypeError("connection lost"));
      else controller.close();
      return;
    }
    sent = true;
    controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
  } }));
}
function snapshot(frames: AgentFrame[], status = "running", runId = "run-1") {
  return { status, run: { runId, prompt: "hello", baseline: { messages: [], contextUsage: null }, frames, lastSeq: frames.length } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([false, true])("reconnects an interrupted stream (network error=%s) without duplicating replayed content", async (networkError) => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const api = vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    calls.push(path);
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path === "/sessions/s1/run") return stream(opening, networkError);
    if (path === "/sessions/s1/run/state") return Response.json(snapshot([...opening, { type: "text_delta", delta: "lo", seq: 3 }]));
    if (path.endsWith("/interview") || path.endsWith("/permissions")) return Response.json({ pending: null });
    if (path === "/sessions/s1/run/events?after=3&runId=run-1") return stream([
      { type: "text_delta", delta: "lo", seq: 3 },
      { type: "cost", runCost: 0.12, seq: 4 },
      { type: "done", seq: 5 },
    ]);
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("project-a"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  expect(result.current.status).toBe("streaming");
  expect(result.current.reconnecting).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS); await sending; });
  expect(result.current.messages.map((message) => message.content)).toEqual(["hello", "hello"]);
  expect(result.current.messages.at(-1)?.runCostUsd).toBe(0.12);
  expect(result.current.status).toBe("ready");
  expect(result.current.runState).toBe("done");
  expect(result.current.reconnecting).toBe(false);
  expect(calls.filter((path) => path.endsWith("/run"))).toHaveLength(1);
  expect(api.mock.calls.every((call) => call[2] === "project-a")).toBe(true);
  unmount();
});

it("retries transient reconnect errors and reconciles a run that completed while disconnected", async () => {
  vi.useFakeTimers();
  let states = 0;
  vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return stream(opening);
    if (path.endsWith("/run/state")) {
      if (++states === 1) return new Response("unavailable", { status: 503 });
      return Response.json(snapshot([...opening, { type: "text_delta", delta: "lo", seq: 3 }, { type: "done", seq: 4 }], "complete"));
    }
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS); });
  expect(result.current.status).toBe("streaming");
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS); await sending; });
  expect(result.current.messages.at(-1)?.content).toBe("hello");
  expect(result.current.status).toBe("ready");
  unmount();
});

it("does not apply a reconnect snapshot that resolves after Stop and reset", async () => {
  vi.useFakeTimers();
  let resolveState!: (response: Response) => void;
  const state = new Promise<Response>((resolve) => { resolveState = resolve; });
  const calls: string[] = [];
  vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    calls.push(path);
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return stream(opening);
    if (path.endsWith("/run/state")) return state;
    if (path.endsWith("/abort")) return Response.json({ restored: [] });
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS); });
  await act(async () => { await result.current.stop(); result.current.reset(); });
  await act(async () => {
    resolveState(Response.json(snapshot([...opening, { type: "text_delta", delta: "stale response", seq: 3 }], "complete")));
    await sending;
  });
  expect(result.current.messages).toEqual([]);
  expect(result.current.status).toBe("ready");
  expect(result.current.reconnecting).toBe(false);
  expect(calls.filter((path) => path.endsWith("/abort"))).toHaveLength(1);
  unmount();
});

it("cancels a reconnect delay on unmount without aborting server work", async () => {
  vi.useFakeTimers();
  const api = vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return stream(opening);
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  unmount();
  await sending;
  await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS * 3);
  expect(api.mock.calls.map(([path]) => path)).toEqual(["/sessions", "/sessions/s1/run"]);
});

it.each([401, 500, 503])("keeps the saved binding pending and retries a restore HTTP %s", async (status) => {
  vi.useFakeTimers();
  let attempts = 0;
  const unavailable = vi.fn();
  const api = vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions/stored/run/state") {
      return ++attempts === 1 ? new Response("unavailable", { status }) : Response.json({ status: "none" });
    }
    if (path === "/sessions/stored/history") return Response.json({ messages: [{ role: "user", content: "existing conversation" }] });
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => {
    const agent = useAgent("p");
    const ready = useSessionRestore({ sessionId: "stored", loadSession: agent.loadSession, onUnavailable: unavailable });
    return { agent, ready };
  });
  await act(async () => {});
  expect(result.current.ready).toBe(false);
  expect(unavailable).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_MS); });
  expect(result.current.ready).toBe(true);
  expect(result.current.agent.sessionId).toBe("stored");
  expect(result.current.agent.messages[0]?.content).toBe("existing conversation");
  expect(unavailable).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([path]) => path === "/sessions")).toBe(false);
  unmount();
});

it("classifies only missing history as gone; transient history failure is retryable", async () => {
  let historyStatus = 500;
  vi.spyOn(projects, "apiFetch").mockImplementation(async (path) =>
    path.endsWith("/run/state") ? Response.json({ status: "none" }) : new Response("unavailable", { status: historyStatus }));
  const { result, unmount } = renderHook(() => useAgent("p"));
  await act(async () => { expect(await result.current.loadSession("stored")).toBe("retry"); });
  historyStatus = 404;
  await act(async () => { expect(await result.current.loadSession("stored")).toBe("gone"); });
  unmount();
});

it("recovers completed output and a replacement notice from history instead of its empty baseline", async () => {
  vi.useFakeTimers();
  vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return stream(opening);
    if (path.endsWith("/run/state")) return Response.json({
      status: "complete", run: { ...snapshot([], "complete", "notice-2").run, kind: "notice", origin: "system" },
    });
    if (path.endsWith("/history")) return Response.json({ messages: [
      { role: "user", content: "hello" },
      { role: "assistant", frames: [{ type: "text_delta", delta: "hello, completed during outage" }] },
      { role: "system", content: "Worker finished", customType: "subagent-notify" },
    ] });
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS); await sending; });
  expect(result.current.messages.map((message) => message.content)).toEqual(["hello", "hello, completed during outage", "Worker finished"]);
  expect(result.current.messages.map((message) => message.role)).toEqual(["user", "assistant", "system"]);
  expect(result.current.runState).toBe("idle");
  unmount();
});

it("refreshes the snapshot when a newer run replaces the handle before reconnect subscription", async () => {
  vi.useFakeTimers();
  let probes = 0;
  const api = vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return stream(opening);
    if (path.endsWith("/run/state")) {
      if (++probes === 1) return Response.json(snapshot(opening));
      return Response.json({ status: "complete", run: {
        runId: "run-2", origin: "system", prompt: "", kind: "turn", lastSeq: 3,
        baseline: { messages: [
          { role: "user", content: "hello" },
          { role: "assistant", frames: [{ type: "text_delta", delta: "original finished" }] },
        ], contextUsage: null },
        frames: [
          { type: "run_start", runId: "run-2", seq: 1 },
          { type: "text_delta", delta: "new system response", seq: 2 },
          { type: "done", seq: 3 },
        ],
      } });
    }
    if (path.endsWith("/interview") || path.endsWith("/permissions")) return Response.json({ pending: null });
    if (path === "/sessions/s1/run/events?after=2&runId=run-1") return new Response("run replaced", { status: 409 });
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  let sending!: Promise<string | undefined>;
  await act(async () => { sending = result.current.send("hello"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(RUN_RECONNECT_MS * 2); await sending; });
  expect(result.current.messages.map((message) => message.content)).toEqual(["hello", "original finished", "new system response"]);
  expect(api.mock.calls.some(([path]) => path.includes("&runId=run-1"))).toBe(true);
  unmount();
});

it("finishes on the terminal frame even if the transport does not close", async () => {
  const cancel = vi.fn();
  vi.spyOn(projects, "apiFetch").mockImplementation(async (path) => {
    if (path === "/sessions") return Response.json({ id: "s1" });
    if (path.endsWith("/run")) return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([...opening, { type: "done", seq: 3 }].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
      },
      cancel,
    }));
    throw new Error(`unexpected ${path}`);
  });
  const { result, unmount } = renderHook(() => useAgent("p"));
  await act(async () => { await result.current.send("hello"); });
  expect(result.current.status).toBe("ready");
  expect(result.current.runState).toBe("done");
  expect(cancel).toHaveBeenCalledOnce();
  unmount();
});
