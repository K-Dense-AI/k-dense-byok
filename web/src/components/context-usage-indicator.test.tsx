import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ContextUsageIndicator } from "./context-usage-indicator";

describe("ContextUsageIndicator", () => {
  it("shows Pi context utilization accessibly", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          usage={{ tokens: 42_000, contextWindow: 200_000, percent: 21 }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("21%");
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Model context 21.0 percent, 42,000 of 200,000 tokens",
    );
  });

  it("shows the post-compaction unknown state and hides without usage", () => {
    const { rerender } = render(
      <TooltipProvider>
        <ContextUsageIndicator
          usage={{ tokens: null, contextWindow: 200_000, percent: null }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("?%");

    rerender(
      <TooltipProvider>
        <ContextUsageIndicator usage={null} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
