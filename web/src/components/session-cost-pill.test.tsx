import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionCostPill } from "./session-cost-pill";
import type {
  CostEntry,
  SessionCostSummary,
} from "@/lib/use-session-cost";
import type {
  BudgetState,
  ProjectCostSummary,
} from "@/lib/use-project-cost";

function makeSummary(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
  return {
    sessionId: "sess",
    totalUsd: 0,
    totalTokens: 0,
    agentUsd: 0,
    subagentUsd: 0,
    computeUsd: 0,
    entries: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    entryId: "e1",
    ts: 1,
    sessionId: "sess",
    role: "agent",
    model: "openrouter/anthropic/claude-opus",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedTokens: 0,
    costUsd: 0.01,
    ...overrides,
  };
}

function makeProjectSummary(
  overrides: Partial<ProjectCostSummary> = {},
): ProjectCostSummary {
  const totalUsd = overrides.totalUsd ?? 0;
  const limitUsd = overrides.limitUsd ?? null;
  const state: BudgetState =
    overrides.budget?.state ??
    (limitUsd === null
      ? "ok"
      : totalUsd / limitUsd >= 1
        ? "exceeded"
        : totalUsd / limitUsd >= 0.8
          ? "warn"
          : "ok");
  return {
    projectId: "proj",
    totalUsd,
    totalTokens: 0,
    sessionCount: 1,
    limitUsd,
    budget: {
      totalUsd,
      limitUsd,
      ratio: limitUsd !== null ? totalUsd / limitUsd : null,
      state,
    },
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
      agentUsd: 1.234,
      entries: [makeEntry({ costUsd: 1.234, totalTokens: 1500 })],
    });

    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$1.23");
  });

  it("uses 4 decimals for very small costs", () => {
    const summary = makeSummary({
      totalUsd: 0.00123,
      totalTokens: 100,
      agentUsd: 0.00123,
      entries: [makeEntry({ costUsd: 0.00123, totalTokens: 100 })],
    });
    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$0.0012");
  });

  it("renders project total without a limit when spendLimit is unset", () => {
    const project = makeProjectSummary({ totalUsd: 2.5, sessionCount: 3 });
    const session = makeSummary({
      totalUsd: 1.0,
      agentUsd: 1.0,
      entries: [makeEntry({ costUsd: 1.0, totalTokens: 10 })],
    });
    render(<SessionCostPill summary={session} projectSummary={project} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("proj");
    expect(button).toHaveTextContent("$2.50");
    expect(button).toHaveTextContent("sess");
    expect(button).toHaveTextContent("$1.00");
    expect(button).not.toHaveTextContent("/");
  });

  it("shows limit and default tone when under 80% of cap", () => {
    const project = makeProjectSummary({ totalUsd: 3.0, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.25,
      agentUsd: 0.25,
      entries: [makeEntry({ costUsd: 0.25, totalTokens: 10 })],
    });
    render(
      <SessionCostPill
        summary={session}
        projectSummary={project}
        limitUsd={10.0}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("proj");
    expect(button).toHaveTextContent("$3.00");
    expect(button).toHaveTextContent("/ $10.00");
    // The only destructive classes on a non-exceeded button come from default
    // shadcn base styles (aria-invalid:*). Our budget-specific override
    // strings (text-destructive, border-destructive/60, border-amber-500/60)
    // must not be present.
    expect(button.className).not.toContain("text-destructive");
    expect(button.className).not.toContain("border-destructive/60");
    expect(button.className).not.toContain("border-amber-500/60");
  });

  it("applies the warn tone when usage is between 80% and 100%", () => {
    const project = makeProjectSummary({ totalUsd: 8.5, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.5,
      agentUsd: 0.5,
      entries: [makeEntry({ costUsd: 0.5, totalTokens: 10 })],
    });
    render(
      <SessionCostPill
        summary={session}
        projectSummary={project}
        limitUsd={10.0}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-amber-500/60");
  });

  it("applies the destructive tone and lock icon when the budget is exceeded", () => {
    const project = makeProjectSummary({ totalUsd: 12.0, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.5,
      agentUsd: 0.5,
      entries: [makeEntry({ costUsd: 0.5, totalTokens: 10 })],
    });
    render(
      <SessionCostPill
        summary={session}
        projectSummary={project}
        limitUsd={10.0}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-destructive/60");
    expect(button.className).toContain("text-destructive");
    // Lock icon is rendered as an inline SVG; check it's present
    expect(button.querySelector("svg")).not.toBeNull();
  });
});
