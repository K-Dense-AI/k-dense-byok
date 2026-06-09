import { describe, expect, it } from "vitest";

import { applyFrameToMessage, type ChatMessage } from "@/lib/use-agent";

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
      { type: "tool_start", toolCallId: "s1", toolName: "spawn_subagent" },
      10,
    );
    expect(running.activities?.[0].label).toBe("Spawning a subagent");
    const errored = applyFrameToMessage(
      running,
      { type: "tool_end", toolCallId: "s1", toolName: "spawn_subagent", isError: true },
      20,
    );
    expect(errored.activities?.[0].status).toBe("error");
  });

  it("surfaces an error frame into content when empty", () => {
    const m = applyFrameToMessage(baseMessage(), { type: "error", message: "boom" }, 10);
    expect(m.content).toContain("boom");
  });
});
