import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SystemCard, systemCardKind } from "./system-card";
import { ChatMessageRow } from "./chat-tab";
import type { ChatMessage } from "@/lib/use-agent";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "sys",
  role: "system",
  content: "Child asks: which cutoff?",
  customType: "subagent_supervisor_request",
  timestamp: 1,
  ...overrides,
});

describe("systemCardKind", () => {
  it("maps known pi-subagents types and falls back to Notice", () => {
    expect(systemCardKind("subagent_supervisor_request").label).toBe("Subagent needs a decision");
    expect(systemCardKind("subagent_watchdog_warning")).toMatchObject({ label: "Watchdog warning", tone: "warning" });
    expect(systemCardKind("subagent-notify").label).toBe("Background subagent finished");
    expect(systemCardKind("compaction").label).toBe("Context compacted");
    expect(systemCardKind("something-else").label).toBe("Notice");
  });
});

describe("SystemCard", () => {
  it("renders the label, body, severity and scalar details", () => {
    render(
      <SystemCard
        message={message({
          customType: "subagent_watchdog_warning",
          content: "Claims tests passed without running them",
          details: { severity: "blocker", category: "test-gap", agent: "worker", summary: "dup" },
        })}
      />,
    );
    expect(screen.getByText("Watchdog warning")).toBeInTheDocument();
    expect(screen.getByText("Claims tests passed without running them")).toBeInTheDocument();
    expect(screen.getByText("blocker")).toBeInTheDocument();
    expect(screen.getByText("category")).toBeInTheDocument();
    expect(screen.getByText("test-gap")).toBeInTheDocument();
    expect(screen.queryByText("summary")).toBeNull();
  });

  it("renders a compaction as a divider with the token count", () => {
    render(<SystemCard message={message({ customType: "compaction", content: "Context compacted", details: { tokensBefore: 120000, reason: "manual" } })} />);
    const divider = screen.getByRole("separator", { name: "Context compacted" });
    expect(divider.textContent).toContain("120,000 tokens summarized");
    expect(divider.textContent).toContain("manual");
  });

  it("collapses long bodies behind Show more", () => {
    render(<SystemCard message={message({ content: "y".repeat(700) })} />);
    expect(screen.getByText("Show more")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("is what ChatMessageRow renders for role system", () => {
    const { container } = render(
      <ChatMessageRow
        message={message({})}
        isStreaming={false}
        isLast
        sessionId="s"
        projectId="default"
        onCopy={vi.fn()}
        copied={false}
      />,
    );
    expect(container.querySelector('[data-system-card="subagent_supervisor_request"]')).not.toBeNull();
    expect(screen.getByText("Subagent needs a decision")).toBeInTheDocument();
  });
});
