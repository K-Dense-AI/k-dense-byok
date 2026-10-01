import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectModelCard } from "@/components/connect-model-card";
import { SettingsLink } from "@/components/settings-link";
import { onOpenSettings } from "@/lib/settings-nav";

describe("ConnectModelCard", () => {
  it("deep-links each path into Settings → Providers", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const stop = onOpenSettings(handler);
    render(<ConnectModelCard />);
    await user.click(screen.getByRole("button", { name: /sign in with a subscription/i }));
    await user.click(screen.getByRole("button", { name: /add an api key/i }));
    await user.click(screen.getByRole("button", { name: /use a local model/i }));
    stop();
    expect(handler.mock.calls.map(([request]) => request)).toEqual([
      { tab: "providers", section: "subscriptions" },
      { tab: "providers", section: "api-keys" },
      { tab: "providers", section: "local-servers" },
    ]);
  });
});

describe("SettingsLink", () => {
  it("opens the named tab", async () => {
    const handler = vi.fn();
    const stop = onOpenSettings(handler);
    render(
      <SettingsLink tab="project" section="budget">
        Raise the limit
      </SettingsLink>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Raise the limit" }));
    stop();
    expect(handler).toHaveBeenCalledWith({ tab: "project", section: "budget", projectId: undefined });
  });
});
