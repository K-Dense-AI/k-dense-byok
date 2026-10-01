import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as appSettings from "@/lib/app-settings";
import * as projectsLib from "@/lib/projects";
import * as modalJobs from "@/lib/use-modal-jobs";
import { DefaultsPanel } from "@/components/settings/defaults-panel";

beforeEach(() => {
  appSettings.resetAppDefaultsCache();
  vi.spyOn(projectsLib, "apiFetch").mockResolvedValue(new Response("{}", { status: 200 }));
  vi.spyOn(modalJobs, "useModalCatalog").mockReturnValue({
    catalog: null,
    loading: false,
    error: null,
    refresh: () => {},
  });
});
afterEach(() => vi.restoreAllMocks());

describe("DefaultsPanel", () => {
  it("saves a typed default model and leaves untouched keys cleared", async () => {
    const user = userEvent.setup();
    vi.spyOn(appSettings, "getAppDefaults").mockResolvedValue({});
    const put = vi.spyOn(appSettings, "putAppDefaults").mockImplementation(async (patch) => ({
      ...(patch.model ? { model: patch.model } : {}),
    }));
    render(<DefaultsPanel />);

    const save = await screen.findByRole("button", { name: "Save defaults" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Type a model id for Default model" }));
    await user.type(screen.getByLabelText("Default model"), "openrouter/openai/gpt-5.5{Enter}");
    await user.click(save);

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith({
        model: "openrouter/openai/gpt-5.5",
        thinkingLevel: null,
        compute: null,
      }),
    );
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it("shows the load error instead of an empty form", async () => {
    vi.spyOn(appSettings, "getAppDefaults").mockRejectedValue(new Error("Failed to load defaults (500)"));
    render(<DefaultsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load defaults (500)");
  });
});
