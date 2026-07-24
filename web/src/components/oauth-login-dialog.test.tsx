import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OAuthLoginDialog } from "./oauth-login-dialog";
import type {
  ModelProviderStatus,
  ProviderAuthFlow,
} from "@/lib/use-provider-auth";

const provider: ModelProviderStatus = {
  id: "openai-codex",
  name: "OpenAI Codex",
  accountLabel: "ChatGPT Plus/Pro",
  billingMode: "subscription",
  billingNote: "Provider managed.",
  connected: false,
  credentialType: null,
  source: null,
  loginLabel: null,
  modelCount: 0,
};

const awaiting: ProviderAuthFlow = {
  id: "flow-1",
  providerId: "openai-codex",
  status: "awaiting_input",
  events: [
    {
      type: "auth_url",
      url: "https://example.com/oauth",
      instructions: "Continue in your browser.",
    },
  ],
  prompt: {
    id: "prompt-1",
    type: "select",
    message: "Select login method",
    options: [
      { id: "browser", label: "Browser login" },
      { id: "device", label: "Device code login" },
    ],
  },
  createdAt: 1,
  updatedAt: 1,
  expiresAt: Date.now() + 60_000,
};

describe("OAuthLoginDialog", () => {
  it("renders Pi auth events and submits a selected prompt answer", async () => {
    const user = userEvent.setup();
    const respond = vi.fn(async () => ({
      ...awaiting,
      status: "complete" as const,
      prompt: undefined,
    }));
    const onConnected = vi.fn();

    render(
      <OAuthLoginDialog
        provider={provider}
        open
        onOpenChange={vi.fn()}
        start={vi.fn(async () => awaiting)}
        poll={vi.fn(async () => awaiting)}
        respond={respond}
        cancel={vi.fn(async () => ({ ...awaiting, status: "cancelled" as const }))}
        onConnected={onConnected}
      />,
    );

    expect(await screen.findByRole("link", { name: /open sign-in page/i })).toHaveAttribute(
      "href",
      "https://example.com/oauth",
    );
    await user.click(screen.getByRole("button", { name: /device code login/i }));
    expect(respond).toHaveBeenCalledWith("flow-1", "prompt-1", "device");
    await waitFor(() => expect(screen.getByText(/connected successfully/i)).toBeInTheDocument());
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("cancels a live flow when the dialog closes", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => ({
      ...awaiting,
      status: "cancelled" as const,
      prompt: undefined,
    }));
    const onOpenChange = vi.fn();

    render(
      <OAuthLoginDialog
        provider={provider}
        open
        onOpenChange={onOpenChange}
        start={vi.fn(async () => awaiting)}
        poll={vi.fn(async () => awaiting)}
        respond={vi.fn(async () => awaiting)}
        cancel={cancel}
      />,
    );

    await screen.findByText("Select login method");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith("flow-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders device codes with an explicit verification link", async () => {
    render(
      <OAuthLoginDialog
        provider={{ ...provider, id: "xai", accountLabel: "SuperGrok or X Premium" }}
        open
        onOpenChange={vi.fn()}
        start={vi.fn(async () => ({
          ...awaiting,
          providerId: "xai",
          status: "running",
          prompt: undefined,
          events: [
            {
              type: "device_code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://example.com/device",
              expiresInSeconds: 600,
            },
          ],
        }) as ProviderAuthFlow)}
        poll={vi.fn(async () => awaiting)}
        respond={vi.fn(async () => awaiting)}
        cancel={vi.fn(async () => ({ ...awaiting, status: "cancelled" as const }))}
      />,
    );

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open verification page/i })).toHaveAttribute(
      "href",
      "https://example.com/device",
    );
    expect(screen.getByText(/expires in about 10 minutes/i)).toBeInTheDocument();
  });

  it("submits manual redirect codes without echoing them afterwards", async () => {
    const user = userEvent.setup();
    const manual: ProviderAuthFlow = {
      ...awaiting,
      prompt: {
        id: "manual-1",
        type: "manual_code",
        message: "Paste the redirect URL",
        placeholder: "http://localhost/callback",
      },
    };
    const respond = vi.fn(async () => ({
      ...manual,
      status: "running" as const,
      prompt: undefined,
    }));

    render(
      <OAuthLoginDialog
        provider={provider}
        open
        onOpenChange={vi.fn()}
        start={vi.fn(async () => manual)}
        poll={vi.fn(async () => manual)}
        respond={respond}
        cancel={vi.fn(async () => ({ ...manual, status: "cancelled" as const }))}
      />,
    );

    const input = await screen.findByLabelText("Paste the redirect URL");
    await user.type(input, "sensitive-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledWith("flow-1", "manual-1", "sensitive-code");
    expect(screen.queryByDisplayValue("sensitive-code")).not.toBeInTheDocument();
  });

  it("allows an empty text answer for GitHub's default github.com prompt", async () => {
    const user = userEvent.setup();
    const githubPrompt: ProviderAuthFlow = {
      ...awaiting,
      providerId: "github-copilot",
      prompt: {
        id: "github-domain",
        type: "text",
        message: "GitHub Enterprise URL/domain (blank for github.com)",
      },
    };
    const respond = vi.fn(async () => ({
      ...githubPrompt,
      status: "running" as const,
      prompt: undefined,
    }));

    render(
      <OAuthLoginDialog
        provider={{
          ...provider,
          id: "github-copilot",
          accountLabel: "GitHub Copilot subscription",
        }}
        open
        onOpenChange={vi.fn()}
        start={vi.fn(async () => githubPrompt)}
        poll={vi.fn(async () => githubPrompt)}
        respond={respond}
        cancel={vi.fn(async () => ({
          ...githubPrompt,
          status: "cancelled" as const,
        }))}
      />,
    );

    await screen.findByLabelText(/GitHub Enterprise URL/i);
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(respond).toHaveBeenCalledWith("flow-1", "github-domain", "");
  });

  it("cancels a flow that starts after the dialog was already closed", async () => {
    const user = userEvent.setup();
    let resolveStart!: (flow: ProviderAuthFlow) => void;
    const start = vi.fn(
      () =>
        new Promise<ProviderAuthFlow>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const cancel = vi.fn(async () => ({
      ...awaiting,
      status: "cancelled" as const,
    }));
    const onOpenChange = vi.fn();

    render(
      <OAuthLoginDialog
        provider={provider}
        open
        onOpenChange={onOpenChange}
        start={start}
        poll={vi.fn(async () => awaiting)}
        respond={vi.fn(async () => awaiting)}
        cancel={cancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveStart(awaiting));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("flow-1"));
  });
});
