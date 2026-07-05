import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OutlineItem } from "@/lib/latex/outline";
import { OutlinePanel } from "./outline-panel";

const ITEMS: OutlineItem[] = [
  { kind: "section", title: "Intro", line: 3, depth: 2 },
  { kind: "subsection", title: "Background", line: 5, depth: 3 },
  { kind: "figure", title: "A plot", line: 7, depth: 4 },
];

describe("OutlinePanel", () => {
  it("renders items and jumps on click", () => {
    const onJump = vi.fn();
    render(<OutlinePanel items={ITEMS} currentLine={5} onJump={onJump} />);
    fireEvent.click(screen.getByText("Intro"));
    expect(onJump).toHaveBeenCalledWith(3);
  });
  it("shows an empty state without items", () => {
    render(<OutlinePanel items={[]} currentLine={1} onJump={() => {}} />);
    expect(screen.getByText(/no sections yet/i)).toBeTruthy();
  });
});
