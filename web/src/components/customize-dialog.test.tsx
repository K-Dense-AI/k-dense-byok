import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/skills-panel", () => ({ SkillsPanel: () => <div>skills-panel</div> }));
vi.mock("@/components/connectors-panel", () => ({ ConnectorsPanel: () => <div>connectors-panel</div> }));
vi.mock("@/components/subagents-panel", () => ({ SubagentsPanel: () => <div>subagents-panel</div> }));

import { CustomizeDialog } from "@/components/customize-dialog";

describe("CustomizeDialog", () => {
  it("renders the three capability tabs when open", () => {
    render(<CustomizeDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /specialists/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /connectors/i })).toBeInTheDocument();
  });
});
