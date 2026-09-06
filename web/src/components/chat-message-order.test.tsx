import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssistantMessageBody, ChatMessageRow } from "./chat-tab";
import type { ChatMessage } from "@/lib/use-agent";

describe("AssistantMessageBody", () => {
  it("skips unchanged history rows without disabling their copy action", () => {
    const content = vi.fn(() => "Completed reply");
    const message: ChatMessage = { id: "old", role: "assistant", timestamp: 1, get content() { return content(); } };
    const onCopy = vi.fn();
    const props = { message, isStreaming: false, isLast: false, sessionId: "s", projectId: "default", copied: false, onCopy };
    const { rerender } = render(<ChatMessageRow {...props} />);
    const reads = content.mock.calls.length;
    rerender(<ChatMessageRow {...props} />);
    expect(content).toHaveBeenCalledTimes(reads);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith("old", "Completed reply");
  });
  it("renders prose around a running tool in stream order", () => {
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "Before tool.\n\nAfter tool.",
      timestamp: 1,
      activities: [
        {
          id: "tool-1",
          label: "Running bash",
          status: "running",
          timestamp: 2,
          toolName: "bash",
          args: { command: "sleep 5" },
        },
      ],
      segments: [
        { type: "text", content: "Before tool.\n\n" },
        { type: "activity", activityId: "tool-1" },
        { type: "text", content: "After tool." },
      ],
    };

    const { container } = render(
      <AssistantMessageBody
        message={message}
        isStreaming
        isLast
        sessionId="session-1"
        projectId="default"
      />,
    );

    const before = screen.getByText("Before tool.");
    const tool = container.querySelector('[data-tool-call-id="tool-1"]');
    const after = screen.getByText("After tool.");

    expect(tool).not.toBeNull();
    expect(
      before.compareDocumentPosition(tool!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tool!.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a preamble before a pending interview", () => {
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "I need one detail.\n\n",
      timestamp: 1,
      activities: [
        {
          id: "interview-1",
          label: "Running interview",
          status: "running",
          timestamp: 2,
          toolName: "interview",
          args: {
            title: "Choose an option",
            questions: [
              {
                id: "choice",
                type: "single",
                question: "Which option?",
                options: ["A", "B"],
              },
            ],
          },
        },
      ],
      segments: [
        { type: "text", content: "I need one detail.\n\n" },
        { type: "activity", activityId: "interview-1" },
      ],
    };

    render(
      <AssistantMessageBody
        message={message}
        isStreaming
        isLast
        sessionId="session-1"
        projectId="default"
      />,
    );

    const preamble = screen.getByText("I need one detail.");
    const interview = screen.getByText("Choose an option");
    expect(
      preamble.compareDocumentPosition(interview) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a typed scientific card between surrounding prose", () => {
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "Computed the comparison.\n\nInterpretation follows.",
      timestamp: 1,
      activities: [
        {
          id: "result-1",
          label: "Scientific result",
          status: "complete",
          timestamp: 2,
          toolName: "scientific_result",
          scientificResult: {
            schemaVersion: 1,
            kind: "statistical-test",
            title: "Treatment effect",
            tests: [{ name: "Welch t-test", pValue: 0.02 }],
          },
        },
      ],
      segments: [
        { type: "text", content: "Computed the comparison.\n\n" },
        { type: "activity", activityId: "result-1" },
        { type: "text", content: "Interpretation follows." },
      ],
    };

    const { container } = render(
      <AssistantMessageBody
        message={message}
        isStreaming={false}
        isLast
        sessionId="session-1"
        projectId="default"
      />,
    );

    const before = screen.getByText("Computed the comparison.");
    const card = container.querySelector('[data-tool-call-id="result-1"]');
    const after = screen.getByText("Interpretation follows.");
    expect(card).not.toBeNull();
    expect(
      before.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      card!.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
