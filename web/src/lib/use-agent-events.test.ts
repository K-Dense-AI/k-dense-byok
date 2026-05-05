import { describe, expect, it } from "vitest";

import { applyAgentEventToMessage, type ChatMessage } from "@/lib/use-agent";

const baseMessage = (): ChatMessage => ({
  id: "assistant",
  role: "assistant",
  content: "",
  timestamp: 1,
});

describe("applyAgentEventToMessage", () => {
  it("appends partial text and replaces final text", () => {
    const partial = applyAgentEventToMessage(
      baseMessage(),
      { partial: true, content: { parts: [{ text: "hel" }] } },
      () => "generated",
      10
    );

    expect(partial.content).toBe("hel");

    const final = applyAgentEventToMessage(
      partial,
      { partial: false, content: { parts: [{ text: "hello" }] } },
      () => "generated",
      11
    );

    expect(final.content).toBe("hello");
  });

  it("records turn id and model version from event metadata", () => {
    const next = applyAgentEventToMessage(
      baseMessage(),
      {
        modelVersion: "openrouter/example",
        actions: { stateDelta: { _turnId: "turn-123" } },
      },
      () => "generated",
      10
    );

    expect(next.modelVersion).toBe("openrouter/example");
    expect(next.turnId).toBe("turn-123");
  });

  it("pairs tool responses with running tool calls", () => {
    const running = applyAgentEventToMessage(
      baseMessage(),
      {
        content: {
          parts: [{ functionCall: { id: "tool-1", name: "delegate_task" } }],
        },
      },
      () => "generated",
      10
    );

    const complete = applyAgentEventToMessage(
      running,
      {
        content: {
          parts: [
            {
              functionResponse: {
                id: "tool-1",
                name: "delegate_task",
                response: { result: "done", skills_used: ["analysis"] },
              },
            },
          ],
        },
      },
      () => "generated",
      20
    );

    expect(complete.activities).toHaveLength(1);
    expect(complete.activities?.[0]).toMatchObject({
      id: "tool-1",
      label: "Specialist finished",
      status: "complete",
      detail: "Used 'analysis' skills",
    });
  });
});
