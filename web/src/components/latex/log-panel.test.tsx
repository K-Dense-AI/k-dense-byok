import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogPanel } from "./log-panel";

const props = { open: true, onClose: vi.fn(), filter: "all" as const, onFilterChange: vi.fn(), fileName: "paper/chapters/intro.tex", compileTarget: "paper/main.tex" };
const log = "./chapters/intro.tex:7: Right error.\n./appendix/intro.tex:8: Wrong error.";

describe("LogPanel", () => {
  it("navigates and offers AI fixes only for the exact open source file", () => {
    const onJump = vi.fn(), onFixError = vi.fn();
    render(<LogPanel {...props} log={log} onJump={onJump} onFixError={onFixError} />);
    fireEvent.click(screen.getByRole("button", { name: /Right error/ }));
    expect(onJump).toHaveBeenCalledWith(7);
    expect(screen.getAllByRole("button", { name: "Fix with AI" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Fix with AI" }));
    expect(onFixError).toHaveBeenCalledWith(7, "Right error.");
  });
  it("keeps stale logs readable without using their old line locations", () => {
    render(<LogPanel {...props} log={log} stale onJump={vi.fn()} onFixError={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Right error|Fix with AI/ })).toBeNull();
    expect(screen.getByText(/Source changed/)).toBeInTheDocument();
  });
  it("shows non-TeX failures even with an empty log in Problems view", () => {
    render(<LogPanel {...props} log="" filter="problems" errors={["bibtex not found"]} />);
    expect(screen.getByText("bibtex not found")).toBeInTheDocument();
    expect(screen.queryByText(/No problems found/)).toBeNull();
  });
});
