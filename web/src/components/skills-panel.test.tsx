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

function listing(overrides: Partial<caps.SkillsListing> = {}): caps.SkillsListing {
  return {
    scope: "project",
    enabled: [],
    disabled: [],
    problems: [],
    shadowed: [],
    ...overrides,
  };
}

const skill = (name: string, description: string, extra: Partial<caps.SkillInfo> = {}) => ({
  id: name,
  name,
  description,
  ...extra,
});

describe("SkillsPanel", () => {
  it("lists enabled and disabled skills and toggles one off", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({
        enabled: [skill("scanpy", "single cell")],
        disabled: [skill("old", "legacy")],
      }),
    );
    const setSpy = vi.spyOn(caps, "setSkillEnabled").mockResolvedValue();

    render(<SkillsPanel />);
    expect(await screen.findByText("scanpy")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();

    const scanpyToggle = screen.getByRole("switch", { name: /scanpy/i });
    await userEvent.click(scanpyToggle);
    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith("scanpy", false, "project"),
    );
  });

  it("distinguishes an unseeded project from a filter with no hits", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(listing());

    render(<SkillsPanel />);
    expect(await screen.findByText(/No skills installed/i)).toBeInTheDocument();
    expect(screen.queryByText("No skills match.")).not.toBeInTheDocument();
  });

  it("says nothing matched once a search hides every skill", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({ enabled: [skill("scanpy", "single cell")] }),
    );

    render(<SkillsPanel />);
    await screen.findByText("scanpy");
    await userEvent.type(screen.getByPlaceholderText("Search skills…"), "zzz");
    expect(await screen.findByText("No skills match.")).toBeInTheDocument();
  });

  it("flags an installed skill that failed to parse", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({
        enabled: [skill("scanpy", "single cell")],
        problems: [
          {
            name: "genomic-intelligence",
            state: "enabled",
            loaded: false,
            message: "Nested mappings are not allowed in compact mappings at line 2",
          },
          // Loaded-with-a-warning skills are not the user's problem — they show up
          // in the list normally and must not be reported as missing.
          {
            name: "scanpy",
            state: "enabled",
            loaded: true,
            message: "description exceeds 1024",
          },
        ],
      }),
    );

    render(<SkillsPanel />);
    expect(
      await screen.findByText(/1 installed skill could not be loaded/i),
    ).toBeInTheDocument();
    expect(screen.getByText("genomic-intelligence")).toBeInTheDocument();
    expect(screen.getByText(/Nested mappings/)).toBeInTheDocument();
    expect(screen.queryByText(/description exceeds 1024/)).not.toBeInTheDocument();
  });

  it("refreshes the upstream catalogue on demand", async () => {
    stubProjects();
    const rows = listing({
      enabled: [skill("paperclip", "papers")],
      sync: syncStatus(),
    });
    const getSpy = vi.spyOn(caps, "getAllSkills").mockResolvedValue(rows);
    const syncSpy = vi.spyOn(caps, "syncSkills").mockResolvedValue();

    render(<SkillsPanel />);
    await screen.findByText("paperclip");
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(syncSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));
  });

  it("surfaces conflicts and replaces a local copy only after confirmation", async () => {
    stubProjects();
    const initial = listing({
      enabled: [skill("scanpy", "single cell")],
      sync: syncStatus({ updatesAvailable: ["scanpy"], customized: ["scanpy"] }),
    });
    const after = listing({
      ...initial,
      sync: syncStatus({ updatesAvailable: [], customized: [] }),
    });
    vi.spyOn(caps, "getAllSkills")
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(after);
    const updateSpy = vi.spyOn(caps, "updateSkillFromUpstream").mockResolvedValue();

    render(<SkillsPanel />);
    expect(await screen.findByText("Update available")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /use upstream version of scanpy/i }),
    );

    // Nothing happens until the in-app confirmation is accepted.
    expect(updateSpy).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: /^replace$/i }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("scanpy", "project"));
    await waitFor(() =>
      expect(screen.queryByText("Update available")).not.toBeInTheDocument(),
    );
  });

  it("labels where each skill came from", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({
        enabled: [
          skill("scanpy", "single cell", { origin: "catalogue" }),
          skill("web-design", "design", {
            origin: "registry",
            source: "vercel-labs/agent-skills",
          }),
          skill("lab-qc", "our qc", { origin: "local" }),
        ],
      }),
    );

    render(<SkillsPanel />);
    expect(await screen.findByText("K-Dense")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("vercel-labs/agent-skills")).toBeInTheDocument();
  });

  it("reloads for the all-projects scope and warns about shadowing", async () => {
    stubProjects();
    const getSpy = vi
      .spyOn(caps, "getAllSkills")
      .mockResolvedValueOnce(listing({ enabled: [skill("scanpy", "single cell")] }))
      .mockResolvedValue(
        listing({
          scope: "global",
          enabled: [skill("shared-skill", "everywhere", { origin: "registry" })],
          shadowed: ["shared-skill"],
        }),
      );

    render(<SkillsPanel />);
    await screen.findByText("scanpy");
    await userEvent.click(screen.getByRole("button", { name: /all projects/i }));

    await waitFor(() => expect(getSpy).toHaveBeenLastCalledWith("global"));
    expect(await screen.findByText("shared-skill")).toBeInTheDocument();
    expect(screen.getByText(/Shadowed by a project skill/i)).toBeInTheDocument();
    // The catalogue is per project, so its refresh has nothing to do here.
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("previews a source and installs only after the trust box is ticked", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(listing());
    const previewSpy = vi.spyOn(caps, "previewSkillSource").mockResolvedValue({
      source: "vercel-labs/agent-skills",
      stagingKey: "key",
      stagingToken: "token",
      skills: [
        { name: "web-design", description: "design rules", files: 1, installed: false },
        { name: "writing", description: "writing rules", files: 2, installed: false },
      ],
      problems: [],
    });
    const installSpy = vi
      .spyOn(caps, "installSkills")
      .mockResolvedValue({ installed: ["web-design", "writing"], conflicts: [] });

    render(<SkillsPanel />);
    await screen.findByText(/No skills installed/i);

    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await userEvent.type(
      screen.getByPlaceholderText(/owner\/repo/i),
      "vercel-labs/agent-skills",
    );
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    expect(await screen.findByText("web-design")).toBeInTheDocument();

    // The install button stays disabled until the acknowledgement is ticked —
    // the server enforces the same thing, this is just the honest affordance.
    const installButton = screen.getByRole("button", { name: /install 2 skills/i });
    expect(installButton).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /trust this source/i }));
    await waitFor(() => expect(installButton).toBeEnabled());
    await userEvent.click(installButton);

    await waitFor(() =>
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "vercel-labs/agent-skills",
          stagingToken: "token",
          acknowledged: true,
          scope: "project",
        }),
      ),
    );
    expect(installSpy.mock.calls[0][0].names.sort()).toEqual(["web-design", "writing"]);
  });

  it("creates a skill and opens it for editing", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(listing());
    const createSpy = vi
      .spyOn(caps, "createSkill")
      .mockResolvedValue({ name: "lab-qc" });
    vi.spyOn(caps, "getSkillSource").mockResolvedValue(
      "---\nname: lab-qc\ndescription: x\n---\n",
    );

    render(<SkillsPanel />);
    await screen.findByText(/No skills installed/i);
    await userEvent.click(screen.getByRole("button", { name: /new skill/i }));
    await userEvent.type(screen.getByPlaceholderText(/skill-name/i), "lab-qc");
    await userEvent.click(screen.getByRole("button", { name: /create and edit/i }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "lab-qc", scope: "project" }),
      ),
    );
    expect(await screen.findByLabelText(/SKILL.md for lab-qc/i)).toBeInTheDocument();
  });

  it("edits and saves a skill's SKILL.md", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({ enabled: [skill("lab-qc", "our qc", { origin: "local" })] }),
    );
    vi.spyOn(caps, "getSkillSource").mockResolvedValue("original");
    const saveSpy = vi.spyOn(caps, "saveSkillSource").mockResolvedValue();

    render(<SkillsPanel />);
    await screen.findByText("lab-qc");
    await userEvent.click(screen.getByRole("button", { name: /edit lab-qc/i }));

    const editor = await screen.findByLabelText(/SKILL.md for lab-qc/i);
    await userEvent.clear(editor);
    await userEvent.type(editor, "rewritten");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith("lab-qc", "rewritten", "project"),
    );
  });

  it("explains that removing a catalogue skill archives it", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({ enabled: [skill("scanpy", "single cell", { origin: "catalogue" })] }),
    );
    const removeSpy = vi
      .spyOn(caps, "removeSkill")
      .mockResolvedValue({ name: "scanpy", disposition: "archived" });

    render(<SkillsPanel />);
    await screen.findByText("scanpy");
    await userEvent.click(screen.getByRole("button", { name: /remove scanpy/i }));

    // The confirmation spells out that a catalogue skill is archived, not deleted.
    expect(await screen.findByText(/archived/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("scanpy", "project"));
    expect(await screen.findByText(/Archived scanpy/i)).toBeInTheDocument();
  });

  it("does not remove anything when the confirmation is declined", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({ enabled: [skill("scanpy", "single cell")] }),
    );
    const removeSpy = vi.spyOn(caps, "removeSkill");

    render(<SkillsPanel />);
    await screen.findByText("scanpy");
    await userEvent.click(screen.getByRole("button", { name: /remove scanpy/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("checks an installed skill's source for updates on request", async () => {
    stubProjects();
    vi.spyOn(caps, "getAllSkills").mockResolvedValue(
      listing({
        enabled: [
          skill("web-design", "design", { origin: "registry", source: "owner/repo" }),
        ],
      }),
    );
    const checkSpy = vi
      .spyOn(caps, "checkSkillUpdate")
      .mockResolvedValue({ name: "web-design", updateAvailable: false });

    render(<SkillsPanel />);
    await screen.findByText("web-design");
    await userEvent.click(
      screen.getByRole("button", { name: /check web-design for updates/i }),
    );

    await waitFor(() =>
      expect(checkSpy).toHaveBeenCalledWith("web-design", "project"),
    );
    expect(await screen.findByText(/web-design is up to date/i)).toBeInTheDocument();
  });
});
