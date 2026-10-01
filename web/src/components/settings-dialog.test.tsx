import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/projects", () => ({
  apiFetch,
  onProjectChange: () => () => {},
  useProjectScopeId: () => "p1",
}));

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({
    activeProject: { id: "p1", name: "P1" },
    activeProjectId: "p1",
    projects: [
      { id: "p1", name: "P1" },
      { id: "p2", name: "Other" },
    ],
  }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NO_MODAL = {
  modalTokenId: { set: false, masked: null },
  modalTokenSecret: { set: false, masked: null },
};

/**
 * Route mocked fetches by URL rather than call order: each panel fires
 * several independent GETs on mount (/credentials, /providers, …), so an
 * ordered mock queue would hand the wrong body to whichever lands first.
 */
function routeFetch(onCredentialsPut: () => Response | Promise<Response> = () => json(NO_MODAL)) {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/providers") return json({ providers: [] });
    if (url === "/model-providers") return json({ providers: [] });
    if (url === "/credentials" && init?.method === "PUT") return onCredentialsPut();
    if (url === "/credentials") return json(NO_MODAL);
    if (url === "/modal/cache") return json({ cache: null });
    return json({});
  });
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    window.localStorage.clear();
    routeFetch();
  });

  it("groups model, project and workspace tabs", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    for (const name of [
      "Providers",
      "Defaults",
      "Fusion",
      "General",
      "Skills",
      "Prompt templates",
      "Specialists",
      "Connectors",
      "Services",
      "Appearance",
    ]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("· P1")).toBeInTheDocument();
    // Providers is the landing tab on a first open.
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens on the requested tab and names the targeted project", async () => {
    const { rerender } = render(<SettingsDialog open onOpenChange={() => {}} request={{ tab: "services" }} />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Services" })).toHaveAttribute("aria-selected", "true"),
    );
    rerender(<SettingsDialog open onOpenChange={() => {}} request={{ tab: "skills", projectId: "p2" }} />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getByText("· Other")).toBeInTheDocument();
    // Skills follow the active project, so the dialog says which one it shows.
    expect(screen.getByRole("note")).toHaveTextContent(/Showing the current project, P1/);
  });

  it("maps legacy tab ids and remembers the last tab", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <SettingsDialog open onOpenChange={() => {}} request={{ tab: "api-keys" as never }} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Services" })).toHaveAttribute("aria-selected", "true"),
    );
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    unmount();
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
  });

  it("saves Modal credentials as a tested pair and broadcasts the change", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener("kady:credentials-changed", changed);
    routeFetch(() =>
      json({
        modalConfigured: true,
        modalTokenId: { set: true, masked: "ak-…1234" },
        modalTokenSecret: { set: true, masked: "as-…5678" },
      }),
    );

    render(<SettingsDialog open onOpenChange={() => {}} request={{ tab: "services" }} />);
    await screen.findByText("Not connected");
    await user.type(screen.getByLabelText("Token ID"), "ak-test");
    await user.type(screen.getByLabelText("Token Secret"), "as-test");
    await user.click(screen.getByRole("button", { name: /save & test/i }));

    expect(await screen.findByText(/Connected — Modal compute is ready/i)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      "/credentials",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          modalTokenId: "ak-test",
          modalTokenSecret: "as-test",
        }),
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener("kady:credentials-changed", changed);
  });

  it("shows Testing and handles backend pair-validation errors", async () => {
    let resolveSave!: (response: Response) => void;
    routeFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<SettingsDialog open onOpenChange={() => {}} request={{ tab: "services" }} />);
    await screen.findByText("Not connected");
    fireEvent.change(screen.getByLabelText("Token ID"), { target: { value: "ak-bad" } });
    fireEvent.change(screen.getByLabelText("Token Secret"), { target: { value: "as-bad" } });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));
    expect(screen.getByText(/Testing Modal connection/i)).toBeInTheDocument();

    resolveSave(
      new Response(
        JSON.stringify({
          detail: {
            message: "Modal token pair could not be authenticated",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Modal token pair could not be authenticated"),
    );
  });
});
