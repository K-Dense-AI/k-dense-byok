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

function syncStatus(overrides: Partial<caps.SkillSyncStatus> = {}): caps.SkillSyncStatus {
  return {
    ...caps.EMPTY_SKILL_SYNC_STATUS,
    lastCheckedAt: "2026-07-29T20:00:00.000Z",
    ...overrides,
  };
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

  it("refreshes the upstream catalogue on demand", async () => {
    stubProjects();
    const listing = {
      enabled: [{ id: "paperclip", name: "paperclip", description: "papers" }],
      disabled: [],
      problems: [],
      sync: syncStatus(),
    };
    const getSpy = vi.spyOn(caps, "getAllSkills").mockResolvedValue(listing);
    const syncSpy = vi.spyOn(caps, "syncSkills").mockResolvedValue();

    render(<SkillsPanel />);
    await screen.findByText("paperclip");
    await userEvent.click(screen.getByRole("button", { name: /refresh now/i }));

    await waitFor(() => expect(syncSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));
  });

  it("surfaces conflicts and replaces a local copy only after confirmation", async () => {
    stubProjects();
    const initial = {
      enabled: [{ id: "scanpy", name: "scanpy", description: "single cell" }],
      disabled: [],
      problems: [],
      sync: syncStatus({
        updatesAvailable: ["scanpy"],
        customized: ["scanpy"],
      }),
    };
    const after = {
      ...initial,
      sync: syncStatus({ updatesAvailable: [], customized: [] }),
    };
    vi.spyOn(caps, "getAllSkills")
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(after);
    const updateSpy = vi.spyOn(caps, "updateSkillFromUpstream").mockResolvedValue();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SkillsPanel />);
    expect(await screen.findByText("Update available")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /use upstream version of scanpy/i }),
    );

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("scanpy"));
    await waitFor(() => expect(screen.queryByText("Update available")).not.toBeInTheDocument());
  });
});
