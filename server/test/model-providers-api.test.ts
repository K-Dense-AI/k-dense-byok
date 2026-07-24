import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  ProviderAuthManager,
  type ProviderAuthRuntime,
} from "../src/agent/provider-auth.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";

const apps: ReturnType<typeof Fastify>[] = [];

function model(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function runtime(): ProviderAuthRuntime {
  return {
    login: vi.fn(async () => ({
      type: "oauth",
      access: "never-return-this-access-token",
      refresh: "never-return-this-refresh-token",
      expires: Date.now() + 60_000,
    })),
    logout: vi.fn(async () => {}),
    checkAuth: vi.fn(async (providerId) =>
      providerId === "openai-codex"
        ? { type: "oauth" as const, source: "OAuth" }
        : undefined,
    ),
    getAuth: vi.fn(async (providerId) =>
      providerId === "openai-codex"
        ? { auth: { apiKey: "resolved-but-never-returned" }, source: "OAuth" }
        : undefined,
    ),
    listCredentials: vi.fn(async () => [
      { providerId: "openai-codex", type: "oauth" as const },
    ]),
    getAvailable: vi.fn(async (providerId) =>
      providerId === "openai-codex"
        ? [model("openai-codex", "gpt-test")]
        : [],
    ),
    getProvider: vi.fn(() => undefined),
  } as unknown as ProviderAuthRuntime;
}

async function appWithRuntime(authRuntime = runtime()) {
  const app = Fastify();
  apps.push(app);
  const manager = new ProviderAuthManager(authRuntime);
  await registerModelProviderRoutes(app, { runtime: authRuntime, manager });
  return { app, authRuntime };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("model-provider routes", () => {
  it("returns non-secret OAuth status and available direct models", async () => {
    const { app } = await appWithRuntime();

    const status = await app.inject({ method: "GET", url: "/model-providers" });
    expect(status.statusCode).toBe(200);
    expect(status.json().providers).toContainEqual(
      expect.objectContaining({
        id: "openai-codex",
        connected: true,
        credentialType: "oauth",
        modelCount: 1,
      }),
    );
    expect(status.body).not.toContain("access-token");
    expect(status.body).not.toContain("refresh-token");

    const models = await app.inject({
      method: "GET",
      url: "/model-providers/models",
    });
    expect(models.statusCode).toBe(200);
    expect(models.json().models).toEqual([
      expect.objectContaining({
        id: "openai-codex/gpt-test",
        sourceId: "openai-codex",
        billingMode: "subscription",
        available: true,
      }),
    ]);
  });

  it("validates providers and delegates logout to Pi", async () => {
    const { app, authRuntime } = await appWithRuntime();

    const invalid = await app.inject({
      method: "POST",
      url: "/model-auth/flows",
      payload: { providerId: "not-a-provider" },
    });
    expect(invalid.statusCode).toBe(400);

    const logout = await app.inject({
      method: "DELETE",
      url: "/model-providers/openai-codex/credential",
    });
    expect(logout.statusCode).toBe(200);
    expect(authRuntime.logout).toHaveBeenCalledWith("openai-codex");
  });

  it("marks stored OAuth that cannot refresh as requiring reauthentication", async () => {
    const authRuntime = runtime();
    authRuntime.getAuth = vi.fn(async () => {
      throw new Error("invalid_grant");
    }) as ProviderAuthRuntime["getAuth"];
    const { app } = await appWithRuntime(authRuntime);

    const status = await app.inject({ method: "GET", url: "/model-providers" });
    expect(status.json().providers).toContainEqual(
      expect.objectContaining({
        id: "openai-codex",
        connected: false,
        needsReauth: true,
      }),
    );
    const models = await app.inject({
      method: "GET",
      url: "/model-providers/models",
    });
    expect(models.json().models).toEqual([]);
  });
});
