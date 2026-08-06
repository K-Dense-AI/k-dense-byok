import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  assertModelAuthentication,
  modelReference,
  ModelResolutionError,
  nvidiaExtraModelIds,
  resolveModel,
} from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
  normalizeUsageCost,
} from "../src/cost/billing.ts";
import {
  ProviderAuthManager,
  type ProviderAuthRuntime,
} from "../src/agent/provider-auth.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";

describe("NVIDIA NIM model resolution", () => {
  const registry = getModelRegistry();

  it("resolves a catalogued NIM model through Pi's builtin nvidia provider", () => {
    // NIM model ids contain slashes; the ref must not be split after "nvidia/".
    const model = resolveModel("nvidia/meta/llama-3.3-70b-instruct", registry);
    expect(model.provider).toBe("nvidia");
    expect(model.id).toBe("meta/llama-3.3-70b-instruct");
    expect(modelReference(model)).toBe("nvidia/meta/llama-3.3-70b-instruct");
  });

  it("synthesizes NIM models newer than Pi's catalogue snapshot", () => {
    const model = resolveModel("nvidia/vendor/brand-new-model", registry);
    expect(model.provider).toBe("nvidia");
    expect(model.baseUrl).toContain("integrate.api.nvidia.com");
    // $0 matches Pi's own NIM entries (credits-billed, not per-token USD).
    expect(model.cost.input).toBe(0);
    expect(model.cost.output).toBe(0);
  });

  it("rejects a bare nvidia/ ref with no model id", () => {
    expect(() => resolveModel("nvidia/", registry)).toThrowError(
      ModelResolutionError,
    );
  });

  it("accepts an API key (unlike OAuth-only subscription providers)", async () => {
    const model = resolveModel("nvidia/meta/llama-3.3-70b-instruct", registry);
    const apiKeyRuntime = {
      checkAuth: async () => ({ type: "api_key" as const, source: "NVIDIA_API_KEY" }),
    };
    await expect(
      assertModelAuthentication(
        model,
        apiKeyRuntime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).resolves.toBeUndefined();
  });

  it("names Settings in the error when no key is configured", async () => {
    const model = resolveModel("nvidia/meta/llama-3.3-70b-instruct", registry);
    const unconfigured = { checkAuth: async () => undefined };
    await expect(
      assertModelAuthentication(
        model,
        unconfigured as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).rejects.toThrowError(/NVIDIA is not configured/);
  });
});

describe("NVIDIA NIM billing policy", () => {
  it("classifies usage as external (subscription-like) spend", () => {
    const billing = billingForProvider("nvidia", "api_key");
    expect(billing.billingMode).toBe("subscription");
    // NIM draws NVIDIA-managed API credits; an exceeded project cap must not
    // block runs that ledger $0, and NIM usage must never erode the cap.
    expect(billingCountsTowardBudget(billing)).toBe(false);
    expect(normalizeUsageCost(0, billing)).toEqual({ costUsd: 0 });
  });
});

// ---------------------------------------------------------------------------
// /nvidia/models route
// ---------------------------------------------------------------------------

const apps: ReturnType<typeof Fastify>[] = [];

function nvidiaModel(id: string): Model<any> {
  return {
    provider: "nvidia",
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

function runtimeWithNvidiaKey(configured: boolean): ProviderAuthRuntime {
  return {
    login: vi.fn(),
    logout: vi.fn(async () => {}),
    checkAuth: vi.fn(async (providerId: string) =>
      configured && providerId === "nvidia"
        ? { type: "api_key" as const, source: "NVIDIA_API_KEY" }
        : undefined,
    ),
    getAuth: vi.fn(async () => undefined),
    listCredentials: vi.fn(async () => []),
    getAvailable: vi.fn(async (providerId: string) =>
      providerId === "nvidia"
        ? [nvidiaModel("nvidia/llama-3.3-nemotron-super-49b-v1.5")]
        : [],
    ),
    getProvider: vi.fn(() => undefined),
  } as unknown as ProviderAuthRuntime;
}

async function appWithRuntime(authRuntime: ProviderAuthRuntime) {
  const app = Fastify();
  apps.push(app);
  const manager = new ProviderAuthManager(authRuntime);
  await registerModelProviderRoutes(app, { runtime: authRuntime, manager });
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("NVIDIA_EXTRA_MODELS parsing", () => {
  afterEach(() => {
    delete process.env.NVIDIA_EXTRA_MODELS;
  });

  it("splits on commas and whitespace, dedupes, keeps slashes intact", () => {
    process.env.NVIDIA_EXTRA_MODELS =
      "private/vendor/example-model, vendor/other\nprivate/vendor/example-model";
    expect(nvidiaExtraModelIds()).toEqual([
      "private/vendor/example-model",
      "vendor/other",
    ]);
  });

  it("returns [] when unset", () => {
    expect(nvidiaExtraModelIds()).toEqual([]);
  });
});

describe("GET /nvidia/models", () => {
  afterEach(() => {
    delete process.env.NVIDIA_EXTRA_MODELS;
  });

  it("returns picker-shaped models once a key resolves", async () => {
    const app = await appWithRuntime(runtimeWithNvidiaKey(true));
    const response = await app.inject({ method: "GET", url: "/nvidia/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      models: [
        expect.objectContaining({
          id: "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
          sourceId: "nvidia",
          sourceLabel: "NVIDIA NIM",
          billingMode: "subscription",
          available: true,
        }),
      ],
    });
  });

  it("appends NVIDIA_EXTRA_MODELS ids the catalogue doesn't know", async () => {
    process.env.NVIDIA_EXTRA_MODELS =
      // Second id is already catalogued and must not be duplicated.
      "private/vendor/example-model,nvidia/llama-3.3-nemotron-super-49b-v1.5";
    const app = await appWithRuntime(runtimeWithNvidiaKey(true));
    const response = await app.inject({ method: "GET", url: "/nvidia/models" });
    expect(response.statusCode).toBe(200);
    const { models } = response.json();
    expect(models.map((m: { id: string }) => m.id)).toEqual([
      "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/private/vendor/example-model",
    ]);
    expect(models[1]).toMatchObject({
      sourceId: "nvidia",
      sourceLabel: "NVIDIA NIM",
      billingMode: "subscription",
      pricing: { prompt: 0, completion: 0 },
      available: true,
    });
  });

  it("stays hidden (configured: false, no models) without a key", async () => {
    const runtime = runtimeWithNvidiaKey(false);
    const app = await appWithRuntime(runtime);
    const response = await app.inject({ method: "GET", url: "/nvidia/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, models: [] });
    expect(runtime.getAvailable).not.toHaveBeenCalled();
  });
});
