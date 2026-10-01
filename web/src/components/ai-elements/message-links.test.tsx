import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectScopeProvider } from "@/lib/projects";
import { MessageResponse } from "./message";

describe("Markdown research artifacts", () => {
  it("opens relative report links in the owning project's file preview", () => {
    const open = vi.fn();
    render(<ProjectScopeProvider value="penguin-study"><MessageResponse mode="static" onOpenFile={open}>
      {"[Report](./results/penguins%20report.md)\n\n![Figure](figures/mass.png)"}
    </MessageResponse></ProjectScopeProvider>);
    const link = screen.getByRole("link", { name: "Report" });
    const url = new URL(link.getAttribute("href")!);
    expect(url.pathname).toBe("/sandbox/raw");
    expect(url.searchParams.get("path")).toBe("results/penguins report.md");
    expect(url.searchParams.get("project")).toBe("penguin-study");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("results/penguins report.md");
    const imageUrl = new URL(screen.getByAltText("Figure").getAttribute("src")!);
    expect(imageUrl.searchParams.get("project")).toBe("penguin-study");
    expect(imageUrl.searchParams.get("path")).toBe("figures/mass.png");
    expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument();
  });

  it("keeps external links external and refuses traversal and script URLs", () => {
    const open = vi.fn();
    render(<MessageResponse mode="static" onOpenFile={open}>
      {'[Source](https://example.org/paper)\n\n[Escape](../private.txt)\n\n[Encoded escape](%2e%2e/private.txt)\n\n[Script](javascript:alert%281%29)'}
    </MessageResponse>);
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://example.org/paper");
    expect(screen.queryByRole("link", { name: "Escape" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Encoded escape" })).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^javascript:/i);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
