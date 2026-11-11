import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SystemCard, collapseNotice, formatNoticeMarkdown, systemCardKind } from "./system-card";
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
    expect(systemCardKind("subagent-slash-text-result").label).toBe("Command output");
    expect(systemCardKind("subagent_control_notice", "Subagent needs attention: worker\nRun: x").label).toBe("Subagent needs attention");
    expect(systemCardKind("subagent_control_notice", "Steered child").label).toBe("Subagent notice");
  });
});

describe("formatNoticeMarkdown", () => {
  it("keeps one fact per line and bolds Label: value pairs", () => {
    const out = formatNoticeMarkdown("Subagent watchdog\nMain: on\nRuntime: idle\n\nSources:\n- user settings.json: found\n- project .pi/settings.json: found");
    expect(out).toBe("Subagent watchdog  \n**Main:** on  \n**Runtime:** idle\n\n**Sources:**\n- user settings.json: found\n- project .pi/settings.json: found");
  });

  it("closes a list before a plain line that follows it", () => {
    expect(formatNoticeMarkdown("Commands:\n- one\n- two\nAgent action: run()")).toBe("**Commands:**\n- one\n- two\n\n**Agent action:** run()");
  });

  it("leaves fenced code and existing markdown blocks alone", () => {
    const text = "Reply with:\n```\nsubagent_supervisor({ action: \"reply\" })\n```\n# Heading\n1. first\n2. second";
    const out = formatNoticeMarkdown(text);
    expect(out).toContain("```\nsubagent_supervisor({ action: \"reply\" })\n```");
    expect(out).toContain("\n# Heading\n1. first\n2. second");
    // A label introducing a block is still a label.
    expect(out.startsWith("**Reply with:**\n```")).toBe(true);
  });
});

describe("collapseNotice", () => {
  it("cuts after eight lines and reports what is hidden", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(collapseNotice(text)).toEqual({ collapsed: Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n") + "…", hiddenLines: 4 });
  });

  it("cuts long single-line notices at a word boundary and leaves short ones alone", () => {
    expect(collapseNotice("short\nnotice")).toBeNull();
    const cut = collapseNotice(Array.from({ length: 200 }, () => "word").join(" "));
    expect(cut?.collapsed.endsWith("word…")).toBe(true);
    expect(cut?.collapsed.length).toBeLessThanOrEqual(602);
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
    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByText("test-gap")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.queryByText("summary")).toBeNull();
  });

  it("hides model-facing details (ids, reply hints, intercom targets) and humanizes the rest", () => {
    render(
      <SystemCard
        message={message({
          content: "Which threshold?",
          details: { id: "req-1", requestId: "req-1", replyTo: "req-1", replyHint: "subagent_supervisor({...})", childTarget: "subagent-x-1", reason: "need_decision", runId: "f65974b6-60b9-4b46", agent: "data-validator", expectsReply: true },
        })}
      />,
    );
    expect(screen.getByText("Reason")).toBeInTheDocument();
    expect(screen.getByText("need decision")).toBeInTheDocument();
    expect(screen.getByText("f65974b6")).toBeInTheDocument();
    expect(screen.queryByText(/replyHint|subagent_supervisor|subagent-x-1|expectsReply|req-1/)).toBeNull();
  });

  it("renders a compaction as a divider with the token count", () => {
    render(<SystemCard message={message({ customType: "compaction", content: "Context compacted", details: { tokensBefore: 120000, reason: "manual" } })} />);
    const divider = screen.getByRole("separator", { name: "Context compacted" });
    expect(divider.textContent).toContain("120,000 tokens summarized");
    expect(divider.textContent).toContain("manual");
  });

  it("collapses long bodies behind Show more", () => {
    render(<SystemCard message={message({ content: Array.from({ length: 20 }, (_, i) => `Fact ${i}: value`).join("\n") })} />);
    expect(screen.getByText("Show more (12 more lines)")).toBeInTheDocument();
    expect(screen.queryByText("value", { exact: false, selector: "p" })).not.toBeNull();
    fireEvent.click(screen.getByText("Show more (12 more lines)"));
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
