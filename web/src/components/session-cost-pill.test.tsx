import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionCostPill } from "./session-cost-pill";
import type {
  CostEntry,
  SessionCostSummary,
} from "@/lib/use-session-cost";

function makeSummary(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
  return {
    sessionId: "sess",
    totalUsd: 0,
    orchestratorUsd: 0,
    expertUsd: 0,
    totalTokens: 0,
    orchestratorTokens: 0,
    expertTokens: 0,
    entries: [],
    byTurn: {},
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    ts: 1,
    sessionId: "sess",
    turnId: "t1",
    role: "orchestrator",
    delegationId: null,
    model: "openrouter/anthropic/claude-opus",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    ...overrides,
  };
}

describe("SessionCostPill", () => {
  it("renders nothing when the summary is empty", () => {
    const { container } = render(<SessionCostPill summary={makeSummary()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a formatted total when there is cost data", () => {
    const summary = makeSummary({
      totalUsd: 1.234,
      totalTokens: 1500,
      entries: [makeEntry({ costUsd: 1.234, totalTokens: 1500 })],
      byTurn: {
        t1: {
          turnId: "t1",
          totalUsd: 1.234,
          orchestratorUsd: 1.234,
          expertUsd: 0,
          totalTokens: 1500,
          entries: [makeEntry({ costUsd: 1.234, totalTokens: 1500 })],
        },
      },
      orchestratorUsd: 1.234,
      orchestratorTokens: 1500,
    });

    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$1.23");
  });

  it("uses 4 decimals for very small costs", () => {
    const summary = makeSummary({
      totalUsd: 0.00123,
      totalTokens: 100,
      entries: [makeEntry({ costUsd: 0.00123, totalTokens: 100 })],
    });
    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$0.0012");
  });
});
