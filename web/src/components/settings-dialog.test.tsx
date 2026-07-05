import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({ activeProject: { id: "p1", name: "P1" }, activeProjectId: "p1" }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

describe("SettingsDialog", () => {
  it("shows the capability tabs (Skills, Specialists, Connectors) alongside API keys", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /api keys/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /specialists/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /connectors/i })).toBeInTheDocument();
  });
});
