import { describe, expect, it } from "vitest";

import {
  applyFrameToMessage,
  applyFrameToTranscript,
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
    expect(r.messages).toBe(messages);
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
