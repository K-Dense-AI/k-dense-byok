import { describe, expect, it } from "vitest";

import {
  applyFrameToMessage,
  applyFrameToTranscript,
  buildRunConsumer,
  pruneEmptyTrailingAssistant,
  type ChatMessage,
  type TranscriptRunState,
} from "@/lib/use-agent";

const baseMessage = (): ChatMessage => ({
  id: "assistant",
  role: "assistant",
  content: "",
  timestamp: 1,
});

describe("applyFrameToMessage", () => {
  it("appends text deltas", () => {
    let m = applyFrameToMessage(baseMessage(), { type: "text_delta", delta: "hel" }, 10);
    m = applyFrameToMessage(m, { type: "text_delta", delta: "lo" }, 11);
    expect(m.content).toBe("hello");
  });

  it("accumulates thinking deltas separately", () => {
    const m = applyFrameToMessage(baseMessage(), { type: "thinking_delta", delta: "hmm" }, 10);
    expect(m.reasoning).toBe("hmm");
    expect(m.content).toBe("");
  });

  it("tracks a tool call from start to completion", () => {
    const running = applyFrameToMessage(
      baseMessage(),
      { type: "tool_start", toolCallId: "t1", toolName: "bash" },
      10,
    );
    expect(running.activities).toHaveLength(1);
    expect(running.activities?.[0]).toMatchObject({ id: "t1", status: "running" });

    const done = applyFrameToMessage(
      running,
      { type: "tool_end", toolCallId: "t1", toolName: "bash", isError: false },
      20,
    );
    expect(done.activities?.[0]).toMatchObject({ id: "t1", status: "complete" });
  });

  it("retains typed scientific details and bounded result images", () => {
    const running = applyFrameToMessage(
      baseMessage(),
      { type: "tool_start", toolCallId: "r1", toolName: "scientific_result" },
      10,
    );
    const done = applyFrameToMessage(
      running,
      {
        type: "tool_end",
        toolCallId: "r1",
        toolName: "scientific_result",
        scientificResult: {
          schemaVersion: 1,
          kind: "table",
          title: "Top hits",
          columns: [{ key: "gene", label: "Gene" }],
          rows: [["TP53"]],
        },
        images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
        imagesTruncated: 2,
      },
      20,
    );
    expect(done.activities?.[0]).toMatchObject({
      status: "complete",
      scientificResult: { kind: "table", title: "Top hits" },
      resultImages: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      resultImagesTruncated: 2,
    });
  });

  it("preserves text and tool calls in stream order", () => {
    let message = applyFrameToMessage(
      baseMessage(),
      { type: "text_delta", delta: "I’ll check that." },
      10,
    );
    message = applyFrameToMessage(
      message,
      { type: "tool_start", toolCallId: "t1", toolName: "bash" },
      11,
    );
    message = applyFrameToMessage(
      message,
      { type: "text_delta", delta: "The check passed." },
      12,
    );

    expect(message.segments).toEqual([
      { type: "text", content: "I’ll check that.\n\n" },
      { type: "activity", activityId: "t1" },
      { type: "text", content: "The check passed." },
    ]);
  });

  it("labels the subagent tool specially and marks errors", () => {
    const running = applyFrameToMessage(
      baseMessage(),
      { type: "tool_start", toolCallId: "s1", toolName: "subagent" },
      10,
    );
    expect(running.activities?.[0].label).toBe("Running a subagent");
    const errored = applyFrameToMessage(
      running,
      { type: "tool_end", toolCallId: "s1", toolName: "subagent", isError: true },
      20,
    );
    expect(errored.activities?.[0].status).toBe("error");
  });

  it("surfaces an error frame into content when empty", () => {
    const m = applyFrameToMessage(baseMessage(), { type: "error", message: "boom" }, 10);
    expect(m.content).toContain("boom");
  });
});

describe("applyFrameToTranscript", () => {
  const start = (): { messages: ChatMessage[]; state: TranscriptRunState } => ({
    messages: [
      { id: "u1", role: "user", content: "run the analysis", timestamp: 1 },
      { id: "a1", role: "assistant", content: "", timestamp: 1 },
    ],
    state: { assistantId: "a1", sawPromptEcho: false },
  });
  const makeNextId = () => {
    let n = 100;
    return () => String(++n);
  };

  it("skips the first user message_start (the prompt echo)", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      makeNextId(),
      5,
    );
    expect(r.messages).toBe(messages);
    expect(r.state.sawPromptEcho).toBe(true);
  });

  it("splits the transcript on a delivered steer", () => {
    const { messages, state } = start();
    const nextId = makeNextId();
    let r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      nextId,
      5,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "text_delta", delta: "starting" },
      nextId,
      6,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "message_start", role: "user", content: "exclude sample 7" },
      nextId,
      7,
    );
    expect(r.messages).toHaveLength(4);
    expect(r.messages[1]).toMatchObject({ id: "a1", content: "starting" });
    expect(r.messages[2]).toMatchObject({ role: "user", content: "exclude sample 7" });
    expect(r.messages[3]).toMatchObject({ role: "assistant", content: "" });
    // Later frames land on the NEW bubble.
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "text_delta", delta: "ok, excluding" },
      nextId,
      8,
    );
    expect(r.messages[3].content).toBe("ok, excluding");
    expect(r.messages[1].content).toBe("starting");
  });

  it("lands the cost frame on the last assistant bubble", () => {
    const { messages, state } = start();
    const nextId = makeNextId();
    let r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      nextId,
      5,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "message_start", role: "user", content: "steer" },
      nextId,
      6,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "cost", runCost: 0.5, runTokens: 42 },
      nextId,
      7,
    );
    const last = r.messages[r.messages.length - 1];
    expect(last).toMatchObject({ runCostUsd: 0.5, runTokens: 42 });
    expect(r.messages[1].runCostUsd).toBeUndefined();
  });

  it("reports pending steering from queue_update without touching messages", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(
      messages,
      state,
      { type: "queue_update", steering: ["a", "b"], followUp: [] },
      makeNextId(),
      5,
    );
    expect(r.steering).toEqual(["a", "b"]);
    expect(r.followUp).toEqual([]);
    expect(r.messages).toBe(messages);
  });

  it("reports pending Pi follow-ups from queue_update", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(
      messages,
      state,
      { type: "queue_update", steering: [], followUp: ["then plot it"] },
      makeNextId(),
      5,
    );
    expect(r.followUp).toEqual(["then plot it"]);
    expect(r.steering).toEqual([]);
  });

  it("ignores a user message_start without content after the echo", () => {
    const { messages } = start();
    const r = applyFrameToTranscript(
      messages,
      { assistantId: "a1", sawPromptEcho: true },
      { type: "message_start", role: "user" },
      makeNextId(),
      5,
    );
    expect(r.messages).toBe(messages);
  });
});

describe("custom (system) messages in the transcript", () => {
  const makeNextId = () => {
    let n = 0;
    return () => `n${++n}`;
  };
  const start = () => {
    const messages: ChatMessage[] = [
      { id: "u", role: "user", content: "run it", timestamp: 1 },
      { id: "a", role: "assistant", content: "", timestamp: 1 },
    ];
    const state: TranscriptRunState = { assistantId: "a", sawPromptEcho: true };
    return { messages, state };
  };
  const supervisor = {
    type: "message_start",
    role: "custom",
    customType: "subagent_supervisor_request",
    content: "Child asks: which cutoff?",
    details: { agent: "worker", reason: "need_decision" },
  };

  it("inserts the card above a still-empty reply bubble", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(messages, state, supervisor, makeNextId(), 5);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    expect(r.messages[1]).toMatchObject({
      role: "system",
      customType: "subagent_supervisor_request",
      content: "Child asks: which cutoff?",
      details: { agent: "worker" },
    });
    expect(r.state.assistantId).toBe("a");
    const r2 = applyFrameToTranscript(r.messages, r.state, { type: "text_delta", delta: "relaying" }, makeNextId(), 6);
    expect(r2.messages[2].content).toBe("relaying");
  });

  it("splits the transcript when the bubble already has content (mid-run watchdog finding)", () => {
    const { messages, state } = start();
    const nextId = makeNextId();
    let r = applyFrameToTranscript(messages, state, { type: "text_delta", delta: "working" }, nextId, 5);
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "message_start", role: "custom", customType: "subagent_watchdog_warning", content: "Tests not run", details: { severity: "blocker" } },
      nextId,
      6,
    );
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(r.messages[1].content).toBe("working");
    expect(r.state.assistantId).toBe(r.messages[3].id);
    r = applyFrameToTranscript(r.messages, r.state, { type: "text_delta", delta: "fixing" }, nextId, 7);
    expect(r.messages[3].content).toBe("fixing");
  });

  it("ignores a custom message without content", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(messages, state, { type: "message_start", role: "custom", customType: "x", content: "  " }, makeNextId(), 5);
    expect(r.messages).toBe(messages);
  });
});

describe("buildRunConsumer / pruneEmptyTrailingAssistant", () => {
  const nextId = (() => {
    let n = 0;
    return () => `c${++n}`;
  })();
  const history: ChatMessage[] = [{ id: "h", role: "user", content: "earlier", timestamp: 1 }];

  it("echoes the prompt for a user run and waits for the echo frame", () => {
    const c = buildRunConsumer(history, { runId: "r1", prompt: "new", images: [{ data: "aW1n", mimeType: "image/png" }] }, nextId, 9);
    expect(c.transcript.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(c.transcript[1]).toMatchObject({ content: "new", images: [{ mimeType: "image/png" }] });
    expect(c.transcriptState).toEqual({ assistantId: c.transcript[2].id, sawPromptEcho: false });
    expect(c.currentRunId).toBe("r1");
  });

  it("adds only a reply bubble for a system run and treats the echo as seen", () => {
    const c = buildRunConsumer(history, { runId: "sys", prompt: "", origin: "system" }, nextId, 9);
    expect(c.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.transcriptState.sawPromptEcho).toBe(true);
  });

  it("prunes only an empty trailing assistant bubble", () => {
    const empty: ChatMessage = { id: "e", role: "assistant", content: "", timestamp: 1 };
    const full: ChatMessage = { id: "f", role: "assistant", content: "done", timestamp: 1 };
    expect(pruneEmptyTrailingAssistant([...history, empty])).toEqual(history);
    const kept = [...history, full];
    expect(pruneEmptyTrailingAssistant(kept)).toBe(kept);
    expect(pruneEmptyTrailingAssistant([...history, { ...empty, reasoning: "hmm" }])).toHaveLength(2);
  });
});

describe("data-guard permission frames", () => {
  it("adds a pending permission card and resolves it in place", () => {
    let message = baseMessage();
    message = applyFrameToMessage(
      message,
      {
        type: "permission_request",
        requestId: "perm_1",
        toolCallId: "tc1",
        toolName: "bash",
        command: "rm -rf results",
        reason: "Destructive shell command: rm -rf results",
      },
      5,
    );
    expect(message.activities).toHaveLength(1);
    expect(message.activities![0]).toMatchObject({
      id: "perm_1",
      toolName: "permission",
      status: "running",
      args: { command: "rm -rf results", toolCallId: "tc1" },
    });
    expect(message.segments).toEqual([{ type: "activity", activityId: "perm_1" }]);
    // Duplicate requests (replay) are ignored.
    expect(applyFrameToMessage(message, { type: "permission_request", requestId: "perm_1" }, 6)).toBe(message);

    const denied = applyFrameToMessage(message, { type: "permission_resolved", requestId: "perm_1", allowed: false, outcome: "denied" }, 7);
    expect(denied.activities![0]).toMatchObject({ status: "error", result: "denied", args: { outcome: "denied" } });
    const allowed = applyFrameToMessage(message, { type: "permission_resolved", requestId: "perm_1", allowed: true, outcome: "allowed" }, 7);
    expect(allowed.activities![0]).toMatchObject({ status: "complete", result: "allowed" });
    expect(applyFrameToMessage(message, { type: "permission_resolved", requestId: "other" }, 8)).toBe(message);
  });
});
