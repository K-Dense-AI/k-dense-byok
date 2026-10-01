import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as projectsLib from "@/lib/projects";
import * as useProjectsLib from "@/lib/use-projects";
import { ProjectSettingsPanel } from "@/components/settings/project-settings-panel";

const project: projectsLib.Project = {
  id: "p1",
  name: "RNA pilot",
  description: "",
  tags: ["genomics"],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  archived: false,
  spendLimitUsd: null,
} as projectsLib.Project;

const compaction: projectsLib.CompactionSettingsResponse = {
  enabled: true,
  reserveTokens: 16000,
  keepRecentTokens: 20000,
  bounds: {
    reserveTokens: { min: 4000, max: 64000 },
    keepRecentTokens: { min: 5000, max: 200000 },
  },
};

let update: ReturnType<typeof vi.fn>;

beforeEach(() => {
  update = vi.fn(async (_id: string, patch: Partial<projectsLib.Project>) => ({ ...project, ...patch }));
  vi.spyOn(useProjectsLib, "useProjects").mockReturnValue({
    projects: [project],
    activeProjectId: "p1",
    activeProject: project,
    update,
  } as unknown as ReturnType<typeof useProjectsLib.useProjects>);
  vi.spyOn(projectsLib, "apiFetch").mockResolvedValue(
    new Response(JSON.stringify({ totalUsd: 1.5, spentUsd: 1.5 }), { status: 200 }),
  );
  vi.spyOn(projectsLib, "getProjectInstructionsStatus").mockResolvedValue("edited");
  vi.spyOn(projectsLib, "getProjectGuardPolicy").mockResolvedValue({
    version: 1,
    protectedPaths: ["user_data/**"],
    destructiveConfirm: true,
  });
  vi.spyOn(projectsLib, "getProjectCompaction").mockResolvedValue(compaction);
});
afterEach(() => vi.restoreAllMocks());

describe("ProjectSettingsPanel", () => {
  it("saves the general card without touching the other cards", async () => {
    const user = userEvent.setup();
    const putGuard = vi.spyOn(projectsLib, "putProjectGuardPolicy");
    const putCompaction = vi.spyOn(projectsLib, "putProjectCompaction");
    render(<ProjectSettingsPanel projectId="p1" />);

    const limit = await screen.findByLabelText(/Spend limit/);
    await user.type(limit, "25");
    const general = limit.closest("fieldset")!;
    await user.click(within(general as HTMLElement).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("p1", {
        name: "RNA pilot",
        description: "",
        tags: ["genomics"],
        spendLimitUsd: 25,
      }),
    );
    expect(putGuard).not.toHaveBeenCalled();
    expect(putCompaction).not.toHaveBeenCalled();
  });

  it("validates compaction against the server's bounds before saving", async () => {
    const user = userEvent.setup();
    const put = vi.spyOn(projectsLib, "putProjectCompaction").mockResolvedValue(compaction);
    render(<ProjectSettingsPanel projectId="p1" />);

    const reserve = await screen.findByLabelText("Reserve tokens");
    await user.clear(reserve);
    await user.type(reserve, "100");
    const card = screen.getByTestId("compaction-settings");
    await user.click(within(card).getByRole("button", { name: "Save" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/between 4,000 and 64,000/);
    expect(put).not.toHaveBeenCalled();

    await user.clear(reserve);
    await user.type(reserve, "8000");
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("p1", { enabled: true, reserveTokens: 8000, keepRecentTokens: 20000 }),
    );
  });

  it("saves guard edits on their own", async () => {
    const user = userEvent.setup();
    const put = vi.spyOn(projectsLib, "putProjectGuardPolicy").mockImplementation(async (_id, patch) => ({
      version: 1,
      protectedPaths: patch.protectedPaths ?? [],
      destructiveConfirm: patch.destructiveConfirm ?? true,
    }));
    render(<ProjectSettingsPanel projectId="p1" />);
    const paths = await screen.findByLabelText("Protected paths");
    await user.type(paths, "\nraw/*.csv");
    await user.click(within(screen.getByTestId("guard-settings")).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("p1", {
        protectedPaths: ["user_data/**", "raw/*.csv"],
        destructiveConfirm: true,
      }),
    );
  });

  it("confirms before restoring an edited AGENTS.md", async () => {
    const user = userEvent.setup();
    const restore = vi.spyOn(projectsLib, "restoreProjectInstructions").mockResolvedValue("current");
    render(<ProjectSettingsPanel projectId="p1" />);
    await user.click(await screen.findByRole("button", { name: "Restore default instructions" }));
    expect(restore).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText(/Up to date/)).toBeInTheDocument();
  });
});
