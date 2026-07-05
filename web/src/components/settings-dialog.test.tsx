import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({ activeProject: { id: "p1", name: "P1" }, activeProjectId: "p1" }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

describe("SettingsDialog", () => {
  it("no longer shows MCP servers or Sub-agents tabs", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByRole("tab", { name: /mcp servers/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /sub-agents/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /api keys/i })).toBeInTheDocument();
  });
});
