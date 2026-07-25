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
      problems: [],
    });
    const setSpy = vi.spyOn(caps, "setSkillEnabled").mockResolvedValue();

    render(<SkillsPanel />);
    expect(await screen.findByText("scanpy")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();

    const scanpyToggle = screen.getByRole("switch", { name: /scanpy/i });
    await userEvent.click(scanpyToggle);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("scanpy", false));
  });

  it("distinguishes an unseeded project from a filter with no hits", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue({ enabled: [], disabled: [], problems: [] });

    render(<SkillsPanel />);
    expect(await screen.findByText(/No skills installed/i)).toBeInTheDocument();
    expect(screen.queryByText("No skills match.")).not.toBeInTheDocument();
  });

  it("says nothing matched once a search hides every skill", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue({
      enabled: [{ id: "scanpy", name: "scanpy", description: "single cell" }],
      disabled: [],
      problems: [],
    });

    render(<SkillsPanel />);
    await screen.findByText("scanpy");
    await userEvent.type(screen.getByPlaceholderText("Search skills…"), "zzz");
    expect(await screen.findByText("No skills match.")).toBeInTheDocument();
  });

  it("flags an installed skill that failed to parse", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue({
      enabled: [{ id: "scanpy", name: "scanpy", description: "single cell" }],
      disabled: [],
      problems: [
        {
          name: "genomic-intelligence",
          state: "enabled",
          loaded: false,
          message: "Nested mappings are not allowed in compact mappings at line 2",
        },
        // Loaded-with-a-warning skills are not the user's problem — they show up
        // in the list normally and must not be reported as missing.
        { name: "scanpy", state: "enabled", loaded: true, message: "description exceeds 1024" },
      ],
    });

    render(<SkillsPanel />);
    expect(await screen.findByText(/1 installed skill could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText("genomic-intelligence")).toBeInTheDocument();
    expect(screen.getByText(/Nested mappings/)).toBeInTheDocument();
    expect(screen.queryByText(/description exceeds 1024/)).not.toBeInTheDocument();
  });
});
