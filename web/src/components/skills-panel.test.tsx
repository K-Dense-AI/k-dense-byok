import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as caps from "@/lib/capabilities";
import * as useProjects from "@/lib/use-projects";
import { SkillsPanel } from "@/components/skills-panel";

afterEach(() => vi.restoreAllMocks());

function stubProjects() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

describe("SkillsPanel", () => {
  it("lists enabled and disabled skills and toggles one off", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue({
      enabled: [{ id: "scanpy", name: "scanpy", description: "single cell" }],
      disabled: [{ id: "old", name: "old", description: "legacy" }],
    });
    const setSpy = vi.spyOn(caps, "setSkillEnabled").mockResolvedValue();

    render(<SkillsPanel />);
    expect(await screen.findByText("scanpy")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();

    const scanpyToggle = screen.getByRole("switch", { name: /scanpy/i });
    await userEvent.click(scanpyToggle);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("scanpy", false));
  });
});
