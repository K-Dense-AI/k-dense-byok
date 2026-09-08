import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as caps from "@/lib/capabilities";
import * as useProjects from "@/lib/use-projects";
import { PromptsPanel } from "@/components/prompts-panel";

afterEach(() => vi.restoreAllMocks());

function stubProjects() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

const template = (name: string, extra: Partial<caps.PromptTemplateInfo> = {}): caps.PromptTemplateInfo => ({
  name,
  description: `${name} description`,
  scope: "project",
  ...extra,
});

describe("PromptsPanel", () => {
  it("lists templates with hints and badges, and opens the editor", async () => {
    stubProjects();
    vi.spyOn(caps, "listPromptTemplates").mockResolvedValue([
      template("qc", { argumentHint: "<file>", seeded: true }),
      template("lit-scan", { shadowed: true }),
    ]);
    const getSource = vi.spyOn(caps, "getPromptTemplateSource").mockResolvedValue({ name: "qc", scope: "project", content: "---\ndescription: QC\n---\nRun QC on $1." });
    const save = vi.spyOn(caps, "savePromptTemplateSource").mockResolvedValue();
    render(<PromptsPanel />);
    expect(await screen.findByText("/qc")).toBeInTheDocument();
    expect(screen.getByText("<file>")).toBeInTheDocument();
    expect(screen.getByText("K-Dense")).toBeInTheDocument();
    expect(screen.getByText("Also defined for all projects")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit qc" }));
    await waitFor(() => expect(getSource).toHaveBeenCalledWith("qc", "project"));
    const editor = await screen.findByLabelText("Template source for qc");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Run better QC on $1.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("qc", "project", "Run better QC on $1."));
  });

  it("creates a template in the chosen scope and switches scopes", async () => {
    stubProjects();
    const list = vi.spyOn(caps, "listPromptTemplates").mockResolvedValue([]);
    const create = vi.spyOn(caps, "createPromptTemplate").mockResolvedValue({ name: "lit-scan", scope: "global", content: "body" });
    render(<PromptsPanel />);
    await screen.findByText("No templates in this project.");
    await userEvent.click(screen.getByRole("tab", { name: "All projects" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("global"));
    await userEvent.click(screen.getByRole("button", { name: "New template" }));
    await userEvent.type(screen.getByLabelText("Template name"), "Lit-Scan");
    await userEvent.type(screen.getByLabelText("Argument hint"), "<topic>");
    await userEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("global", { name: "lit-scan", description: undefined, argumentHint: "<topic>" }),
    );
    expect(await screen.findByLabelText("Template source for lit-scan")).toHaveValue("body");
  });
});
