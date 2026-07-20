import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/projects", () => ({ apiFetch }));

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({ activeProject: { id: "p1", name: "P1" }, activeProjectId: "p1" }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

describe("SettingsDialog", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          openrouter: { set: false, masked: null },
          exa: { set: false, masked: null },
          perplexity: { set: false, masked: null },
          gemini: { set: false, masked: null },
          modalTokenId: { set: false, masked: null },
          modalTokenSecret: { set: false, masked: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("shows the capability tabs (Skills, Specialists, Connectors) alongside API keys", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /api keys/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /specialists/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /connectors/i })).toBeInTheDocument();
  });

  it("saves Modal credentials as a tested pair and broadcasts the change", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener("kady:credentials-changed", changed);
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalTokenId: { set: false, masked: null },
            modalTokenSecret: { set: false, masked: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalConfigured: true,
            modalTokenId: { set: true, masked: "ak-…1234" },
            modalTokenSecret: { set: true, masked: "as-…5678" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<SettingsDialog open onOpenChange={() => {}} />);
    await screen.findByText("Not connected");
    await user.type(screen.getByLabelText("Token ID"), "ak-test");
    await user.type(screen.getByLabelText("Token Secret"), "as-test");
    await user.click(screen.getByRole("button", { name: /save & test/i }));

    expect(await screen.findByText(/Connected — Modal compute is ready/i)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenLastCalledWith(
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
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalTokenId: { set: false, masked: null },
            modalTokenSecret: { set: false, masked: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
      );
    render(<SettingsDialog open onOpenChange={() => {}} />);
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
      expect(
        screen.getByRole("alert"),
      ).toHaveTextContent("Modal token pair could not be authenticated"),
    );
  });
});
