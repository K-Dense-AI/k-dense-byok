import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/projects";

const setActive = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const refresh = vi.fn();

const PROJECTS: Project[] = [
  {
    id: "rna-pilot",
    name: "RNA pilot",
    description: "Compare treatment and control cohorts.",
    tags: ["genomics"],
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
    archived: false,
    spendLimitUsd: 25,
  },
  {
    id: "old-study",
    name: "Old study",
    description: "",
    tags: [],
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-02T12:00:00.000Z",
    archived: true,
    spendLimitUsd: null,
  },
];

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({
    projects: PROJECTS,
    activeProjectId: "rna-pilot",
    activeProject: PROJECTS[0],
    loading: false,
    error: null,
    setActive,
    refresh,
    create,
    update,
    remove,
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}));

vi.mock("@/components/settings-dialog", () => ({
  SettingsDialog: () => null,
}));

import { ProjectView, sortProjects } from "@/components/project-view";

describe("ProjectView", () => {
  beforeEach(() => {
    create.mockResolvedValue({
      ...PROJECTS[0],
      id: "new-project",
      name: "New project",
    });
  });

  it("shows active and archived projects and opens a selected project", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    render(<ProjectView onOpenProject={onOpenProject} />);

    expect(screen.getByRole("heading", { name: "Choose a project" })).toBeInTheDocument();
    expect(screen.getByText("RNA pilot")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("$25 budget")).toBeInTheDocument();
    expect(screen.queryByText("Old study")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /archived projects/i }));
    expect(screen.getByText("Old study")).toBeInTheDocument();

    const card = screen.getByText("RNA pilot").closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    await user.click(
      within(card as HTMLElement).getByRole("button", {
        name: "Open project RNA pilot",
      }),
    );

    expect(setActive).toHaveBeenCalledWith("rna-pilot");
    expect(onOpenProject).toHaveBeenCalledWith("rna-pilot");
  });

  it("creates a project and opens it immediately", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    render(<ProjectView onOpenProject={onOpenProject} />);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "Protein screen");
    await user.type(screen.getByLabelText(/Tags/), "proteomics, pilot");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Protein screen",
        description: "",
        tags: ["proteomics", "pilot"],
        spendLimitUsd: null,
      }),
    );
    expect(setActive).toHaveBeenCalledWith("new-project");
    expect(onOpenProject).toHaveBeenCalledWith("new-project");
  });

  it("filters projects and clears the search", async () => {
    const user = userEvent.setup();
    render(<ProjectView onOpenProject={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "Search projects" }), "old");
    expect(screen.queryByText("RNA pilot")).not.toBeInTheDocument();
    expect(screen.getByText("Old study")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear project search" }));
    expect(screen.getByText("RNA pilot")).toBeInTheDocument();
  });

  it("supports sorting the project directory", () => {
    render(<ProjectView onOpenProject={vi.fn()} />);

    const sort = screen.getByRole("combobox", { name: "Sort projects" });
    expect(sort).toHaveTextContent("Recent activity");
    expect(
      sortProjects(
        [
          { ...PROJECTS[0], id: "z", name: "Zeta" },
          { ...PROJECTS[0], id: "a", name: "Alpha" },
        ],
        "name",
        {},
      ).map((project) => project.name),
    ).toEqual(["Alpha", "Zeta"]);
  });

  it("shows colored runtime indicators for projects needing attention", async () => {
    const user = userEvent.setup();
    render(
      <ProjectView
        onOpenProject={vi.fn()}
        projectActivities={{
          "rna-pilot": {
            running: 1,
            needsInput: 1,
            errors: 1,
            blocked: 1,
            done: 0,
          },
          "old-study": {
            running: 0,
            needsInput: 0,
            errors: 0,
            blocked: 0,
            done: 1,
          },
        }}
      />,
    );

    const activeCard = screen.getByText("RNA pilot").closest('[data-slot="card"]');
    expect(activeCard).not.toBeNull();
    expect(
      within(activeCard as HTMLElement).getByText("Needs your input"),
    ).toBeInTheDocument();
    expect(within(activeCard as HTMLElement).getByText("Error")).toBeInTheDocument();
    expect(within(activeCard as HTMLElement).getByText("Blocked")).toBeInTheDocument();
    expect(within(activeCard as HTMLElement).getByText("Running")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /archived projects/i }));
    const doneCard = screen.getByText("Old study").closest('[data-slot="card"]');
    expect(doneCard).not.toBeNull();
    expect(within(doneCard as HTMLElement).getByText("Done")).toBeInTheDocument();
  });
});
