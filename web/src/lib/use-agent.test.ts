import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projects from "@/lib/projects";
import { buildRunBody, parseContextUsage, useAgent } from "@/lib/use-agent";

/** Build an SSE response body streaming one `data: <json>\n\n` frame per entry. */
function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

describe("buildRunBody", () => {
  it("includes thinkingLevel when provided — including an explicit 'off'", () => {
    expect(
      buildRunBody({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" }),
    ).toEqual({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" });
    // Pi sessions remember the level across runs; "off" must reach the wire to reset it.
    expect(buildRunBody({ message: "hi", thinkingLevel: "off" })).toEqual({
      message: "hi",
      thinkingLevel: "off",
    });
  });

  it("omits thinkingLevel when absent", () => {
    expect(buildRunBody({ message: "hi" })).toEqual({ message: "hi" });
  });

  it("keeps computeTarget behavior: sent when set, omitted for 'local'", () => {
    expect(buildRunBody({ message: "hi", computeTarget: "h100" })).toEqual({
      message: "hi",
      computeTarget: "h100",
    });
    expect(buildRunBody({ message: "hi", computeTarget: "local" })).toEqual({ message: "hi" });
  });

  it("threads GPU count, fallback, and cache defaults only for remote compute", () => {
    const computeOptions = {
      gpuCount: 2,
      gpuFallback: ["l4"],
      cache: "none" as const,
    };
    expect(
      buildRunBody({
        message: "hi",
        computeTarget: "t4",
        computeOptions,
      }),
    ).toEqual({
      message: "hi",
      computeTarget: "t4",
      computeOptions,
    });
    expect(
      buildRunBody({
        message: "hi",
        computeTarget: "local",
        computeOptions,
      }),
    ).toEqual({ message: "hi" });
  });

  it("includes fusionConfig when provided", () => {
    const fusionConfig = { plugins: [] };
    expect(buildRunBody({ message: "hi", model: "fusion/x", fusionConfig })).toEqual({
      message: "hi",
      model: "fusion/x",
      fusionConfig,
    });
  });

  it("includes images when present and omits an empty list", () => {
    const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
    expect(buildRunBody({ message: "hi", images })).toEqual({ message: "hi", images });
    expect(buildRunBody({ message: "hi", images: [] })).toEqual({ message: "hi" });
  });
});

describe("parseContextUsage", () => {
  it("accepts known and post-compaction Pi usage", () => {
    expect(
      parseContextUsage({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
    ).toEqual({ tokens: 42_000, contextWindow: 200_000, percent: 21 });
    expect(
      parseContextUsage({ tokens: null, contextWindow: 200_000, percent: null }),
    ).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
  });

  it("rejects malformed usage", () => {
    expect(parseContextUsage({ tokens: -1, contextWindow: 200_000, percent: -1 })).toBeNull();
    expect(parseContextUsage({ tokens: 1, contextWindow: 0, percent: 1 })).toBeNull();
  });
});

describe("useAgent notebook accumulation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accumulates notebook entries from tool_start frames", async () => {
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string) => {
      if (path === "/sessions") {
        return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
      }
      if (path === "/sessions/s1/run") {
        return new Response(
          sseStream([
            {
              type: "tool_start",
              toolName: "notebook",
              toolCallId: "tc_1",
              args: { type: "hypothesis", title: "Six types" },
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.notebookEntries.map((e) => e.id)).toEqual(["tc_1"]);
  });

  it("tracks Pi context utilization from the SSE stream", async () => {
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string) => {
      if (path === "/sessions") {
        return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
      }
      if (path === "/sessions/s1/run") {
        return new Response(
          sseStream([
            {
              type: "context_usage",
              tokens: 42_000,
              contextWindow: 200_000,
              percent: 21,
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.contextUsage).toEqual({
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
    });
  });

  it("keeps a project-pinned stream alive when the visible project changes", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const calls: Array<{ path: string; projectId?: string; signal?: AbortSignal | null }> = [];

    vi.spyOn(projects, "apiFetch").mockImplementation(
      async (path: string, init?: RequestInit, projectId?: string) => {
        calls.push({ path, projectId, signal: init?.signal });
        if (path === "/sessions") {
          return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
        }
        if (path === "/sessions/s1/run") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                markStarted();
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected apiFetch path: ${path}`);
      },
    );

    const { result } = renderHook(() => useAgent("project-a"));
    let sendPromise!: Promise<string | undefined>;
    act(() => {
      sendPromise = result.current.send("keep going");
    });
    await act(async () => {
      await started;
    });

    const runCall = calls.find((call) => call.path.endsWith("/run"));
    expect(runCall?.projectId).toBe("project-a");
    expect(runCall?.signal?.aborted).toBe(false);
    expect(result.current.status).toBe("streaming");

    act(() => {
      projects.setActiveProjectId("project-b");
    });
    expect(runCall?.signal?.aborted).toBe(false);
    expect(result.current.messages[0]?.content).toBe("keep going");

    await act(async () => {
      streamController.close();
      await sendPromise;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.runState).toBe("done");
  });

  it("marks budget refusals as blocked project activity", async () => {
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string) => {
      if (path === "/sessions") {
        return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
      }
      if (path === "/sessions/s1/run") {
        return new Response(
          sseStream([
            {
              type: "error",
              kind: "budget",
              message: "Project spend limit reached",
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    const { result } = renderHook(() => useAgent("project-a"));
    await act(async () => {
      await result.current.send("continue");
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.runState).toBe("blocked");
  });
});

describe("useAgent live-run reconnect", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replays a snapshot exactly once, then consumes future sequenced frames", async () => {
    const encoder = new TextEncoder();
    let eventsController!: ReadableStreamDefaultController<Uint8Array>;
    let eventsSignal: AbortSignal | null | undefined;
    const calls: Array<{ path: string; projectId?: string }> = [];
    const image = { data: "aW1hZ2U=", mimeType: "image/png" };

    vi.spyOn(projects, "apiFetch").mockImplementation(
      async (path: string, init?: RequestInit, projectId?: string) => {
        calls.push({ path, projectId });
        if (path === "/sessions/live/run/state") {
          return new Response(
            JSON.stringify({
              status: "running",
              run: {
                runId: "run-1",
                prompt: "new prompt",
                images: [image],
                baseline: {
                  messages: [
                    { role: "user", content: "old prompt", timestamp: 1 },
                    {
                      role: "assistant",
                      frames: [{ type: "text_delta", delta: "old answer" }],
                      timestamp: 2,
                    },
                  ],
                  contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
                },
                frames: [
                  { seq: 1, type: "run_start", runId: "run-1" },
                  {
                    seq: 2,
                    type: "context_usage",
                    tokens: 20,
                    contextWindow: 100,
                    percent: 20,
                  },
                  { seq: 3, type: "message_start", role: "user", content: "new prompt" },
                  { seq: 4, type: "text_delta", delta: "hel" },
                  { seq: 5, type: "queue_update", steering: ["queued"] },
                  { seq: 6, type: "tool_end", toolName: "subagent", toolCallId: "sub-1" },
                ],
                lastSeq: 6,
              },
            }),
          );
        }
        if (path === "/sessions/live/interview") {
          return new Response(JSON.stringify({ pending: null }));
        }
        if (path === "/sessions/live/run/events?after=6") {
          eventsSignal = init?.signal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                eventsController = controller;
              },
            }),
          );
        }
        throw new Error(`unexpected apiFetch path: ${path}`);
      },
    );

    const { result } = renderHook(() => useAgent("project-a"));
    let loadPromise!: Promise<boolean>;
    act(() => {
      loadPromise = result.current.loadSession("live");
    });

    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("hel"));
    expect(result.current.messages.filter((message) => message.content === "new prompt")).toHaveLength(1);
    expect(result.current.messages[2]).toMatchObject({ role: "user", images: [image] });
    expect(result.current.pendingSteers).toEqual(["queued"]);
    expect(result.current.subagentCompletions).toBe(1);
    expect(result.current.contextUsage?.tokens).toBe(20);
    expect(eventsSignal?.aborted).toBe(false);

    await act(async () => {
      // seq 6 is replayed by the attach endpoint too; it must have no effect.
      eventsController.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            seq: 6,
            type: "tool_end",
            toolName: "subagent",
            toolCallId: "sub-1",
          })}\n\n`,
        ),
      );
      eventsController.enqueue(
        encoder.encode(`data: ${JSON.stringify({ seq: 7, type: "text_delta", delta: "lo" })}\n\n`),
      );
      eventsController.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            seq: 8,
            type: "cost",
            runCost: 0,
            runTokens: 42,
            runBillingMode: "subscription",
            runProvider: "openai-codex",
            runListPriceUsd: 0.25,
          })}\n\n`,
        ),
      );
      eventsController.enqueue(
        encoder.encode(`data: ${JSON.stringify({ seq: 9, type: "done" })}\n\n`),
      );
      eventsController.close();
      await loadPromise;
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      content: "hello",
      runCostUsd: 0,
      runTokens: 42,
      runBillingMode: "subscription",
      runProvider: "openai-codex",
      runListPriceUsd: 0.25,
    });
    expect(result.current.messages.filter((message) => message.content === "new prompt")).toHaveLength(1);
    expect(result.current.subagentCompletions).toBe(1);
    expect(result.current.pendingSteers).toEqual([]);
    expect(result.current.runState).toBe("done");
    expect(result.current.status).toBe("ready");
    expect(result.current.sessionId).toBe("live");
    expect(calls.every((call) => call.projectId === "project-a")).toBe(true);
  });

  it.each([
    {
      name: "completion",
      error: null,
      expected: "done",
      content: "finished",
    },
    {
      name: "provider error",
      error: { type: "error", message: "provider failed" },
      expected: "error",
      content: "Error: provider failed",
    },
    {
      name: "budget block",
      error: { type: "error", kind: "budget", message: "limit reached" },
      expected: "blocked",
      content: "Error: limit reached",
    },
  ])("restores a retained-complete $name run", async ({ error, expected, content }) => {
    const frames = [
      { seq: 1, type: "message_start", role: "user", content: "prompt" },
      ...(error
        ? [{ seq: 2, ...error }]
        : [{ seq: 2, type: "text_delta", delta: "finished" }]),
      { seq: 3, type: "done" },
    ];
    const fetchMock = vi.spyOn(projects, "apiFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "complete",
          run: {
            runId: "run-complete",
            prompt: "prompt",
            images: [],
            baseline: { messages: [], contextUsage: null },
            frames,
            lastSeq: 3,
          },
        }),
      ),
    );

    const { result } = renderHook(() => useAgent("project-a"));
    await act(async () => {
      expect(await result.current.loadSession("complete")).toBe(true);
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].content).toContain(content);
    expect(result.current.runState).toBe(expected);
    expect(result.current.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses history only when run state is none and preserves project scope", async () => {
    const calls: Array<{ path: string; projectId?: string }> = [];
    vi.spyOn(projects, "apiFetch").mockImplementation(
      async (path: string, _init?: RequestInit, projectId?: string) => {
        calls.push({ path, projectId });
        if (path === "/sessions/idle/run/state") {
          return new Response(JSON.stringify({ status: "none" }));
        }
        if (path === "/sessions/idle/history") {
          return new Response(
            JSON.stringify({
              messages: [
                { role: "user", content: "stored" },
                { role: "assistant", frames: [{ type: "text_delta", delta: "reply" }] },
              ],
              contextUsage: { tokens: 5, contextWindow: 100, percent: 5 },
            }),
          );
        }
        throw new Error(`unexpected apiFetch path: ${path}`);
      },
    );

    const { result } = renderHook(() => useAgent("project-z"));
    await act(async () => {
      expect(await result.current.loadSession("idle")).toBe(true);
    });

    expect(result.current.messages.map((message) => message.content)).toEqual(["stored", "reply"]);
    expect(calls).toEqual([
      { path: "/sessions/idle/run/state", projectId: "project-z" },
      { path: "/sessions/idle/history", projectId: "project-z" },
    ]);
  });

  it("restores a pending interview without duplicating its later replay", async () => {
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string) => {
      if (path === "/sessions/interview/run/state") {
        return new Response(
          JSON.stringify({
            status: "running",
            run: {
              runId: "run-interview",
              prompt: "prompt",
              images: [],
              baseline: { messages: [], contextUsage: null },
              frames: [{ seq: 1, type: "message_start", role: "user", content: "prompt" }],
              lastSeq: 1,
            },
          }),
        );
      }
      if (path === "/sessions/interview/interview") {
        return new Response(
          JSON.stringify({
            pending: {
              toolCallId: "question-1",
              payload: { title: "Choose", questions: [] },
            },
          }),
        );
      }
      if (path === "/sessions/interview/run/events?after=1") {
        return new Response(
          sseStream([
            {
              seq: 2,
              type: "tool_start",
              toolName: "interview",
              toolCallId: "question-1",
              args: { title: "Choose", questions: [] },
            },
            { seq: 3, type: "done" },
          ]),
        );
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.loadSession("interview");
    });

    const interviews = result.current.messages.flatMap(
      (message) => message.activities?.filter((activity) => activity.toolName === "interview") ?? [],
    );
    expect(interviews).toHaveLength(1);
    expect(interviews[0].id).toBe("question-1");
  });

  it("aborts only the browser event fetch on unmount", async () => {
    let eventSignal: AbortSignal | null | undefined;
    let markAttached!: () => void;
    const attached = new Promise<void>((resolve) => {
      markAttached = resolve;
    });
    const calls: string[] = [];
    vi.spyOn(projects, "apiFetch").mockImplementation(
      async (path: string, init?: RequestInit) => {
        calls.push(path);
        if (path === "/sessions/live/run/state") {
          return new Response(
            JSON.stringify({
              status: "running",
              run: {
                runId: "run-live",
                prompt: "prompt",
                images: [],
                baseline: { messages: [], contextUsage: null },
                frames: [{ seq: 1, type: "message_start", role: "user", content: "prompt" }],
                lastSeq: 1,
              },
            }),
          );
        }
        if (path === "/sessions/live/interview") {
          return new Response(JSON.stringify({ pending: null }));
        }
        if (path === "/sessions/live/run/events?after=1") {
          eventSignal = init?.signal;
          markAttached();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                eventSignal?.addEventListener("abort", () => {
                  controller.error(new DOMException("aborted", "AbortError"));
                });
              },
            }),
          );
        }
        throw new Error(`unexpected apiFetch path: ${path}`);
      },
    );

    const { result, unmount } = renderHook(() => useAgent());
    let loadPromise!: Promise<boolean>;
    act(() => {
      loadPromise = result.current.loadSession("live");
    });
    await act(async () => {
      await attached;
    });
    unmount();
    await loadPromise;

    expect(eventSignal?.aborted).toBe(true);
    expect(calls.some((path) => path.endsWith("/abort"))).toBe(false);
  });

  it("explicit stop aborts the server run and returns queued text", async () => {
    let markStreaming!: () => void;
    const streaming = new Promise<void>((resolve) => {
      markStreaming = resolve;
    });
    const calls: string[] = [];
    vi.spyOn(projects, "apiFetch").mockImplementation(
      async (path: string, init?: RequestInit) => {
        calls.push(path);
        if (path === "/sessions") {
          return new Response(JSON.stringify({ id: "stop-me" }));
        }
        if (path === "/sessions/stop-me/run") {
          const signal = init?.signal;
          markStreaming();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                signal?.addEventListener("abort", () => {
                  controller.error(new DOMException("aborted", "AbortError"));
                });
              },
            }),
          );
        }
        if (path === "/sessions/stop-me/abort") {
          return new Response(JSON.stringify({ ok: true, restored: ["queued one", "queued two"] }));
        }
        throw new Error(`unexpected apiFetch path: ${path}`);
      },
    );

    const { result } = renderHook(() => useAgent("project-a"));
    let sendPromise!: Promise<string | undefined>;
    act(() => {
      sendPromise = result.current.send("start");
    });
    await act(async () => {
      await streaming;
    });

    let restored: string[] = [];
    await act(async () => {
      restored = await result.current.stop();
      await sendPromise;
    });

    expect(restored).toEqual(["queued one", "queued two"]);
    expect(calls).toContain("/sessions/stop-me/abort");
    expect(result.current.runState).toBe("idle");
  });
});
