import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  ProviderAuthError,
  ProviderAuthManager,
  type ProviderAuthRuntime,
} from "../src/agent/provider-auth.ts";

const managers: ProviderAuthManager[] = [];

function fakeRuntime(
  login: (providerId: string, interaction: AuthInteraction) => Promise<unknown>,
): ProviderAuthRuntime {
  return {
    login: vi.fn((providerId, _type, interaction) => login(providerId, interaction)),
    logout: vi.fn(async () => {}),
    checkAuth: vi.fn(async () => undefined),
    getAuth: vi.fn(async () => undefined),
    listCredentials: vi.fn(async () => []),
    getAvailable: vi.fn(async () => []),
    getProvider: vi.fn(() => undefined),
  } as unknown as ProviderAuthRuntime;
}

function manager(runtime: ProviderAuthRuntime, ttl?: number): ProviderAuthManager {
  const value = new ProviderAuthManager(runtime, ttl);
  managers.push(value);
  return value;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const value of managers.splice(0)) value.dispose();
});

describe("ProviderAuthManager", () => {
  it("bridges select prompts to a completed Pi OAuth login", async () => {
    const runtime = fakeRuntime(async (_providerId, interaction) => {
      const answer = await interaction.prompt({
        type: "select",
        message: "Choose a login method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device", label: "Device code" },
        ],
      });
      expect(answer).toBe("device");
      interaction.notify({ type: "progress", message: "Finishing" });
      return { type: "oauth", access: "secret", refresh: "secret", expires: Date.now() };
    });
    const auth = manager(runtime);

    const started = await auth.start("openai-codex");
    const waiting = auth.get(started.id);
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.prompt).toMatchObject({
      type: "select",
      message: "Choose a login method",
    });

    auth.respond(started.id, waiting.prompt!.id, "device");
    await tick();

    const complete = auth.get(started.id);
    expect(complete.status).toBe("complete");
    expect(complete.prompt).toBeUndefined();
    expect(complete.events).toContainEqual({ type: "progress", message: "Finishing" });
    expect(JSON.stringify(complete)).not.toContain("secret");
  });

  it("publishes device-code details and cancellation aborts the login", async () => {
    let observedSignal: AbortSignal | undefined;
    const runtime = fakeRuntime(async (_providerId, interaction) => {
      observedSignal = interaction.signal;
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.com/device",
        expiresInSeconds: 900,
      });
      await new Promise<void>((_resolve, reject) => {
        interaction.signal?.addEventListener(
          "abort",
          () => reject(new Error("Login cancelled")),
          { once: true },
        );
      });
    });
    const auth = manager(runtime);
    const started = await auth.start("xai");

    expect(auth.get(started.id).events[0]).toMatchObject({
      type: "device_code",
      userCode: "ABCD-EFGH",
    });
    const cancelled = auth.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    expect(observedSignal?.aborted).toBe(true);
    await tick();
    expect(auth.get(started.id).status).toBe("cancelled");
  });

  it("rejects concurrent logins for one provider but permits another provider", async () => {
    const runtime = fakeRuntime(async (_providerId, interaction) => {
      await interaction.prompt({ type: "text", message: "Wait" });
      return {};
    });
    const auth = manager(runtime);
    await auth.start("github-copilot");

    await expect(auth.start("github-copilot")).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    await expect(auth.start("anthropic")).resolves.toMatchObject({
      providerId: "anthropic",
    });
  });

  it("expires abandoned flows and rejects stale responses", async () => {
    const runtime = fakeRuntime(async (_providerId, interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Paste code" });
      return {};
    });
    const auth = manager(runtime, 5);
    const started = await auth.start("anthropic");
    const promptId = auth.get(started.id).prompt!.id;

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(auth.get(started.id).status).toBe("expired");
    expect(() => auth.respond(started.id, promptId, "code")).toThrowError(
      /not awaiting input/i,
    );
  });

  it("redacts token-shaped values from provider errors", async () => {
    const runtime = fakeRuntime(async () => {
      throw new Error(
        '{"access_token":"eyJabcdefghijklmnopqrstuvwxyz","refresh_token":"sk-abcdefghijklmnopqrstuvwxyz"}',
      );
    });
    const auth = manager(runtime);
    const started = await auth.start("openai-codex");
    await tick();
    const failed = auth.get(started.id);

    expect(failed.status).toBe("error");
    expect(failed.error).toContain("[redacted]");
    expect(failed.error).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("holds the provider lock and removes credentials written after cancellation", async () => {
    let releaseLogin = () => {};
    const runtime = fakeRuntime(
      async () =>
        new Promise((resolve) => {
          releaseLogin = () =>
            resolve({
              type: "oauth",
              access: "late-access",
              refresh: "late-refresh",
              expires: Date.now() + 60_000,
            });
        }),
    );
    const auth = manager(runtime);
    const started = await auth.start("xai");
    auth.cancel(started.id);

    await expect(auth.start("xai")).rejects.toBeInstanceOf(ProviderAuthError);
    releaseLogin();
    await vi.waitFor(() => expect(runtime.logout).toHaveBeenCalledWith("xai"));

    const restarted = await auth.start("xai");
    expect(restarted.providerId).toBe("xai");
  });
});
