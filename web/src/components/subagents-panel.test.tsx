import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentsLib from "@/lib/agents";
import * as useProjects from "@/lib/use-projects";
import { SubagentsPanel } from "@/components/subagents-panel";

beforeEach(() => {
  vi.spyOn(agentsLib, "getSpecialistDefaultModel").mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

const watchdog = (overrides: Partial<agentsLib.WatchdogSettings> = {}): agentsLib.WatchdogSettings => ({
  enabled: false,
  model: "",
  thinking: "",
  cadenceEveryNTools: null,
  severityThreshold: "concern",
  children: false,
  watchdogMd: true,
  stalemateRepeats: 3,
  metered: true,
  ...overrides,
});

describe("SubagentsPanel toggle", () => {
  it("disables a specialist via the switch", async () => {
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
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

describe("WatchdogCard", () => {
  it("shows the metering explanation, enables the watchdog and saves a model", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([]);
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    const save = vi
      .spyOn(agentsLib, "saveWatchdogSettings")
      .mockImplementation(async (patch) => watchdog({ enabled: true, ...patch }));

    render(<SubagentsPanel />);
    expect(await screen.findByText(/Watchdog reviews add model usage/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Enable watchdog" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Type a model id for Watchdog model" }));
    const model = screen.getByLabelText("Watchdog model");
    await userEvent.type(model, "openrouter/openai/gpt-5.5");
    await userEvent.tab();
    await waitFor(() => expect(save).toHaveBeenCalledWith({ model: "openrouter/openai/gpt-5.5" }));
  });
});

describe("SubagentsPanel persistent memory", () => {
  it("shows the Memory button for agents with memory and saves edits", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "data-validator", description: "checks", source: "project", systemPrompt: "x", enabled: true, memory: { scope: "project", path: "data-validator" } },
      { name: "plain", description: "no memory", source: "project", systemPrompt: "y", enabled: true },
    ]);
    vi.spyOn(agentsLib, "getAgentMemory").mockResolvedValue({
      memory: { scope: "project", path: "data-validator" },
      exists: true,
      content: "- old note",
      limits: { lines: 200, bytes: 16384 },
    });
    const save = vi.spyOn(agentsLib, "saveAgentMemory").mockResolvedValue();

    render(<SubagentsPanel />);
    expect(await screen.findByRole("button", { name: "Memory of data-validator" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory of plain" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Memory of data-validator" }));
    const editor = await screen.findByLabelText("MEMORY.md for data-validator");
    expect(editor).toHaveValue("- old note");
    await userEvent.type(editor, "\n- new note");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("data-validator", "- old note\n- new note"));
  });

  it("enables memory from the edit form and sends it in the patch", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "plain", description: "no memory", source: "project", systemPrompt: "y", enabled: true },
    ]);
    const save = vi.spyOn(agentsLib, "saveAgent").mockImplementation(async (name, patch) => ({ name, source: "project", ...patch }));
    render(<SubagentsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit plain" }));
    await userEvent.click(screen.getByRole("switch", { name: "Persistent memory" }));
    await userEvent.selectOptions(screen.getByLabelText("Memory scope"), "user");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toMatchObject({ memory: { scope: "user", path: "plain" } });
  });
});

describe("SubagentsPanel confirmations and defaults", () => {
  const mockProject = () =>
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);

  it("asks before deleting a specialist", async () => {
    mockProject();
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "plain", description: "no memory", source: "project", systemPrompt: "y", enabled: true },
    ]);
    const remove = vi.spyOn(agentsLib, "deleteAgent").mockResolvedValue();
    render(<SubagentsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete plain" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete plain" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("plain"));
  });

  it("asks before restoring the default roster", async () => {
    mockProject();
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([]);
    const restore = vi.spyOn(agentsLib, "restoreDefaultAgents").mockResolvedValue([]);
    render(<SubagentsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /restore defaults/i }));
    expect(restore).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(restore).toHaveBeenCalled());
  });

  it("saves the specialists' default model from a typed id", async () => {
    mockProject();
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog());
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([]);
    const save = vi.spyOn(agentsLib, "saveSpecialistDefaultModel").mockImplementation(async (model) => model);
    render(<SubagentsPanel />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Type a model id for Default specialist model" }),
    );
    await userEvent.type(screen.getByLabelText("Default specialist model"), "openrouter/openai/gpt-5.5{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledWith("openrouter/openai/gpt-5.5"));
  });

  it("commits the watchdog cadence on blur, not per keystroke", async () => {
    mockProject();
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([]);
    vi.spyOn(agentsLib, "getWatchdogSettings").mockResolvedValue(watchdog({ enabled: true }));
    const save = vi
      .spyOn(agentsLib, "saveWatchdogSettings")
      .mockImplementation(async (patch) => watchdog({ enabled: true, ...patch }));
    render(<SubagentsPanel />);
    const cadence = await screen.findByLabelText("Watchdog cadence");
    await userEvent.type(cadence, "50");
    expect(save).not.toHaveBeenCalled();
    await userEvent.tab();
    await waitFor(() => expect(save).toHaveBeenCalledWith({ cadenceEveryNTools: 50 }));
    expect(save).toHaveBeenCalledTimes(1);
  });
});
