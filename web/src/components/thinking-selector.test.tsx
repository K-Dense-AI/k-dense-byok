import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingSelector, THINKING_LEVELS } from "./thinking-selector";

describe("ThinkingSelector", () => {
  it("shows the current level on the chip", () => {
    render(<ThinkingSelector selected="high" onChange={() => {}} />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("lists all six levels and fires onChange with the picked one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThinkingSelector selected="high" onChange={onChange} />);
    await user.click(screen.getByRole("button"));
    // Chip + popover row can both show the selected label — use getAllByText.
    for (const level of THINKING_LEVELS) {
      expect(screen.getAllByText(level.label).length).toBeGreaterThan(0);
    }
    await user.click(screen.getByText("XHigh"));
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("when disabled: shows Off, does not open, never fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThinkingSelector selected="high" onChange={onChange} disabled />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.queryByText("Medium")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
