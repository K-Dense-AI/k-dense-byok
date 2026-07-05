import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentsLib from "@/lib/agents";
import * as useProjects from "@/lib/use-projects";
import { SubagentsPanel } from "@/components/subagents-panel";

afterEach(() => vi.restoreAllMocks());

describe("SubagentsPanel toggle", () => {
  it("disables a specialist via the switch", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "oracle", description: "deep reasoning", source: "builtin", systemPrompt: "x", enabled: true },
    ]);
    const setSpy = vi.spyOn(agentsLib, "setAgentEnabled").mockResolvedValue();

    render(<SubagentsPanel />);
    await screen.findByText("oracle");
    await userEvent.click(screen.getByRole("switch", { name: /toggle oracle/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("oracle", false));
  });
});
