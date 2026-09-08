import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  DIRECT_PROVIDERS,
  directProvider,
  directProviderEnvVars,
  isDirectProvider,
  isPlanBilledProvider,
  providerKeyBodyField,
} from "../src/agent/provider-catalog.ts";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  ProviderAuthManager,
  isSubscriptionProvider,
  type ProviderAuthRuntime,
} from "../src/agent/provider-auth.ts";
import {
  assertModelAuthentication,
  isOAuthOnlyProvider,
  isSubscriptionModelRef,
  ModelAuthenticationError,
  ModelResolutionError,
  modelReference,
  resolveModel,
} from "../src/agent/models.ts";
import { getModelRegistry, getModelRuntime } from "../src/agent/session-registry.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
} from "../src/cost/billing.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";
import {
  credentialFieldFor,
  registerCredentialRoutes,
  setCredentialEnvPathForTests,
} from "../src/api/credentials.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Catalogue ↔ Pi parity
// ---------------------------------------------------------------------------

describe("provider catalogue covers Pi's built-in providers", () => {
  const runtime = getModelRuntime();
  const piProviderIds = runtime.getProviders().map((p) => p.id).sort();

  it("every Pi provider is a direct provider, an OAuth provider, or both", () => {
    // ollama / openai-compatible are Kady's own local registrations (models.ts).
    const uncovered = piProviderIds.filter(
      (id) =>
        !isDirectProvider(id) &&
        !isSubscriptionProvider(id) &&
        id !== "ollama" &&
        id !== "openai-compatible",
    );
    expect(uncovered).toEqual([]);
  });

  it("names no provider Pi doesn't ship (catches upstream renames)", () => {
    const known = new Set(piProviderIds);
    expect(DIRECT_PROVIDERS.map((p) => p.id).filter((id) => !known.has(id))).toEqual([]);
    expect([...SUBSCRIPTION_PROVIDER_IDS].filter((id) => !known.has(id))).toEqual([]);
  });

  it("uses Pi's display names", () => {
    for (const definition of DIRECT_PROVIDERS) {
      expect(runtime.getProvider(definition.id)?.name).toBe(definition.name);
    }
  });

  it("declares env vars Pi actually reads: setting them configures the provider", async () => {
    // Pi resolves API keys from process.env live, so the catalogue's variables
    // can be verified end to end through the real runtime: with only the
    // declared variables set, `checkAuth` must report an api_key credential,
    // and with them unset it must report nothing. An upstream rename would
    // fail here instead of leaving a dead Settings field.
    const touched = new Set<string>();
    const saved = new Map<string, string | undefined>();
    const setEnv = (name: string, value: string | undefined) => {
      if (!saved.has(name)) saved.set(name, process.env[name]);
      touched.add(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      for (const name of directProviderEnvVars()) setEnv(name, undefined);
      for (const definition of DIRECT_PROVIDERS) {
        expect(await runtime.checkAuth(definition.id), `${definition.id} unset`).toBeUndefined();
      }
      for (const definition of DIRECT_PROVIDERS) {
        const vars = [
          ...(definition.keyEnvVar ? [definition.keyEnvVar] : []),
          ...definition.extraEnv.map((f) => f.envVar),
        ];
        for (const name of vars) setEnv(name, `test-value-${name.toLowerCase()}`);
        const auth = await runtime.checkAuth(definition.id);
        expect(auth?.type, `${definition.id} with ${vars.join(", ")}`).toBe("api_key");
        for (const name of vars) setEnv(name, undefined);
      }
    } finally {
      for (const name of touched) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("marks OAuth availability consistently with Pi", () => {
    for (const definition of DIRECT_PROVIDERS) {
      const provider = runtime.getProvider(definition.id)!;
      expect(Boolean(provider.auth.oauth), definition.id).toBe(definition.oauth);
      expect(isSubscriptionProvider(definition.id), definition.id).toBe(definition.oauth);
    }
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      expect(Boolean(runtime.getProvider(id)?.auth.oauth), id).toBe(true);
    }
  });

  it("classifies every $0-priced catalogue as plan-billed", () => {
    // A provider whose whole Pi catalogue is $0 would ledger nothing as payg
    // and then be blocked by an exceeded cap for no reason; the reverse (a
    // priced provider marked plan-billed) would hide real spend from the cap.
    for (const definition of DIRECT_PROVIDERS) {
      const models = runtime.getModels(definition.id);
      if (models.length === 0) continue;
      const zero = models.filter((m) => m.cost.input === 0 && m.cost.output === 0).length;
      if (zero === models.length) {
        expect(definition.billingMode, `${definition.id} is $0 in Pi`).toBe("subscription");
      }
      // NIM and Kimi carry a couple of priced rows beside a $0 catalogue; a
      // provider Pi prices for the most part must never be marked plan-billed.
      if (zero / models.length < 0.5) {
        expect(definition.billingMode, `${definition.id} is priced by Pi`).toBe("payg");
      }
    }
  });

  it("dedupes shared env vars and derives body fields", () => {
    const vars = directProviderEnvVars();
    expect(new Set(vars).size).toBe(vars.length);
    expect(vars).toContain("MOONSHOT_API_KEY");
    expect(vars).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(providerKeyBodyField("cloudflare-ai-gateway")).toBe("cloudflareAiGatewayApiKey");
    expect(providerKeyBodyField("nvidia")).toBe("nvidiaApiKey");
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("direct provider model resolution", () => {
  const registry = getModelRegistry();

  it.each([
    ["groq/llama-3.3-70b-versatile", "groq", "llama-3.3-70b-versatile"],
    ["huggingface/MiniMaxAI/MiniMax-M2", "huggingface", "MiniMaxAI/MiniMax-M2"],
    [
      "fireworks/accounts/fireworks/models/deepseek-v4-flash-0731",
      "fireworks",
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    ],
    [
      "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      "cloudflare-workers-ai",
      "@cf/deepseek-ai/deepseek-v4-flash-0731",
    ],
    ["mistral/codestral-latest", "mistral", "codestral-latest"],
    ["openai/gpt-4", "openai", "gpt-4"],
  ])("resolves %s with the id kept verbatim after the prefix", (ref, provider, id) => {
    const model = resolveModel(ref, registry);
    expect(model.provider).toBe(provider);
    expect(model.id).toBe(id);
    expect(modelReference(model)).toBe(ref);
  });

  it("refuses unknown ids for payg providers instead of synthesizing at $0", () => {
    expect(() => resolveModel("groq/not-a-real-model", registry)).toThrowError(
      ModelResolutionError,
    );
    expect(() => resolveModel("groq/not-a-real-model", registry)).toThrowError(/Groq/);
  });

  it("still synthesizes unknown NIM ids (credit-billed, $0 anyway)", () => {
    expect(directProvider("nvidia")?.synthesizeUnknownIds).toBe(true);
    expect(resolveModel("nvidia/vendor/new", registry).provider).toBe("nvidia");
    expect(DIRECT_PROVIDERS.filter((p) => p.synthesizeUnknownIds).map((p) => p.id)).toEqual([
      "nvidia",
    ]);
  });

  it("keeps openrouter/ refs on the catalogue path, not the direct path", () => {
    expect(isSubscriptionModelRef("openrouter/anthropic/claude-opus-4.8")).toBe(false);
    expect(resolveModel("openrouter/vendor/unknown-model", registry).provider).toBe(
      "openrouter",
    );
  });

  it("rejects a bare provider prefix", () => {
    expect(() => resolveModel("groq/", registry)).toThrowError(ModelResolutionError);
  });
});

// ---------------------------------------------------------------------------
// Authentication policy
// ---------------------------------------------------------------------------

describe("direct provider authentication", () => {
  const registry = getModelRegistry();
  const apiKey = (source: string) => ({
    checkAuth: async () => ({ type: "api_key" as const, source }),
  });
  const oauth = { checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }) };
  const none = { checkAuth: async () => undefined };
  type Runtime = Parameters<typeof assertModelAuthentication>[1];

  it("accepts an API key for dual providers (anthropic, xai, kimi-coding)", async () => {
    for (const ref of ["anthropic/claude-opus-4-8", "xai/grok-4.5", "kimi-coding/k3"]) {
      const model = resolveModel(ref, registry);
      await expect(
        assertModelAuthentication(model, apiKey("ENV") as Runtime),
      ).resolves.toBeUndefined();
      await expect(assertModelAuthentication(model, oauth as Runtime)).resolves.toBeUndefined();
    }
  });

  it("keeps OpenRouter usable with a plain API key despite its OAuth login", async () => {
    // Regression: listing openrouter among the OAuth providers must not turn
    // it OAuth-only — every existing install authenticates it with a key.
    expect(isOAuthOnlyProvider("openrouter")).toBe(false);
    const model = resolveModel("openrouter/openai/gpt-6-astra", registry);
    await expect(
      assertModelAuthentication(model, apiKey("OPENROUTER_API_KEY") as Runtime),
    ).resolves.toBeUndefined();
    await expect(assertModelAuthentication(model, oauth as Runtime)).resolves.toBeUndefined();
    await expect(assertModelAuthentication(model, none as Runtime)).rejects.toThrowError(
      /OpenRouter is not configured/,
    );
  });

  it("still requires OAuth for OAuth-only providers", async () => {
    expect(isOAuthOnlyProvider("openai-codex")).toBe(true);
    expect(isOAuthOnlyProvider("github-copilot")).toBe(true);
    expect(isOAuthOnlyProvider("radius")).toBe(true);
    expect(isOAuthOnlyProvider("anthropic")).toBe(false);
    const model = resolveModel("github-copilot/claude-sonnet-5", registry);
    await expect(
      assertModelAuthentication(model, apiKey("COPILOT_GITHUB_TOKEN") as Runtime),
    ).rejects.toThrowError(ModelAuthenticationError);
  });

  it("points at the right Settings tab when unconfigured", async () => {
    await expect(
      assertModelAuthentication(resolveModel("groq/llama-3.3-70b-versatile", registry), none as Runtime),
    ).rejects.toThrowError(/Groq is not configured\. Add an API key under Settings → API keys/);
    await expect(
      assertModelAuthentication(resolveModel("anthropic/claude-opus-4-8", registry), none as Runtime),
    ).rejects.toThrowError(/API keys or connect it under Settings → Model providers/);
    await expect(
      assertModelAuthentication(resolveModel("openai-codex/gpt-5.4", registry), none as Runtime),
    ).rejects.toThrowError(/Connect it under Settings → Model providers/);
  });
});

// ---------------------------------------------------------------------------
// Billing policy
// ---------------------------------------------------------------------------

describe("direct provider billing", () => {
  it("prices API-key providers pay-as-you-go against the cap", () => {
    for (const provider of ["openai", "groq", "mistral", "anthropic", "xai", "amazon-bedrock"]) {
      const billing = billingForProvider(provider, "api_key");
      expect(billing.billingMode, provider).toBe("payg");
      expect(billingCountsTowardBudget(billing)).toBe(true);
    }
  });

  it("treats prepaid plans and credit pools as external spend", () => {
    for (const provider of [
      "nvidia",
      "qwen-token-plan",
      "qwen-token-plan-cn",
      "xiaomi-token-plan-sgp",
    ]) {
      expect(isPlanBilledProvider(provider), provider).toBe(true);
      const billing = billingForProvider(provider, "api_key");
      expect(billing.billingMode, provider).toBe("subscription");
      expect(billingCountsTowardBudget(billing)).toBe(false);
    }
    // Kimi For Coding: Pi prices the API-key path per token (payg), while the
    // Kimi Code OAuth sign-in is a plan with provider-managed limits.
    expect(isPlanBilledProvider("kimi-coding")).toBe(false);
    expect(billingForProvider("kimi-coding", "api_key").billingMode).toBe("payg");
    expect(billingForProvider("kimi-coding", "oauth").billingMode).toBe("subscription");
  });

  it("bills OpenRouter and Radius OAuth logins like API keys", () => {
    expect(billingForProvider("openrouter", "oauth").billingMode).toBe("payg");
    expect(billingForProvider("radius", "oauth").billingMode).toBe("payg");
  });

  it("keeps the anthropic split: OAuth metered, API key payg", () => {
    expect(billingForProvider("anthropic", "oauth").billingMode).toBe("metered_oauth");
    expect(billingForProvider("anthropic", "api_key").billingMode).toBe("payg");
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const apps: ReturnType<typeof Fastify>[] = [];

function model(provider: string, id: string, cost = 1): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

function runtimeWith(configured: Record<string, "api_key" | "oauth">): ProviderAuthRuntime {
  return {
    login: vi.fn(),
    logout: vi.fn(async () => {}),
    checkAuth: vi.fn(async (providerId: string) =>
      configured[providerId]
        ? { type: configured[providerId], source: `${providerId.toUpperCase()}_KEY` }
        : undefined,
    ),
    getAuth: vi.fn(async (providerId: string) =>
      configured[providerId]
        ? { auth: { apiKey: "resolved-but-never-returned" }, source: "OAuth" }
        : undefined,
    ),
    listCredentials: vi.fn(async () =>
      Object.entries(configured).map(([providerId, type]) => ({ providerId, type })),
    ),
    getAvailable: vi.fn(async (providerId: string) =>
      configured[providerId] ? [model(providerId, `${providerId}-model`)] : [],
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

describe("GET /providers", () => {
  it("lists every direct provider with fields and configured status, no secrets", async () => {
    const app = await appWithRuntime(runtimeWith({ groq: "api_key" }));
    const response = await app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(200);
    const { providers } = response.json();
    expect(providers).toHaveLength(DIRECT_PROVIDERS.length);
    const groq = providers.find((p: { id: string }) => p.id === "groq");
    expect(groq).toMatchObject({
      configured: true,
      authType: "api_key",
      source: "GROQ_KEY",
      modelCount: 1,
      billingMode: "payg",
    });
    expect(groq.fields).toEqual([
      expect.objectContaining({
        envVar: "GROQ_API_KEY",
        isKey: true,
        secret: true,
        credentialId: "groq",
        bodyField: "groqApiKey",
      }),
    ]);
    const cloudflare = providers.find((p: { id: string }) => p.id === "cloudflare-ai-gateway");
    expect(cloudflare.configured).toBe(false);
    expect(cloudflare.fields.map((f: { envVar: string }) => f.envVar)).toEqual([
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
    ]);
    // Google's key row is the existing `gemini` credential.
    const google = providers.find((p: { id: string }) => p.id === "google");
    expect(google.fields[0]).toMatchObject({ credentialId: "gemini", bodyField: "geminiApiKey" });
    expect(response.body).not.toContain("test-secret");
  });
});

describe("GET /providers/models", () => {
  it("returns picker rows for key-configured providers and the full id list", async () => {
    const app = await appWithRuntime(runtimeWith({ groq: "api_key", nvidia: "api_key" }));
    const response = await app.inject({ method: "GET", url: "/providers/models" });
    expect(response.statusCode).toBe(200);
    const { providers, models } = response.json();
    expect(providers).toHaveLength(DIRECT_PROVIDERS.length);
    expect(providers.filter((p: { configured: boolean }) => p.configured).map((p: { id: string }) => p.id)).toEqual(
      ["groq", "nvidia"],
    );
    expect(models).toEqual([
      expect.objectContaining({
        id: "groq/groq-model",
        sourceId: "groq",
        sourceLabel: "Groq",
        billingMode: "payg",
        pricing: { prompt: 1, completion: 1 },
        available: true,
      }),
      expect.objectContaining({
        id: "nvidia/nvidia-model",
        sourceId: "nvidia",
        sourceLabel: "NVIDIA NIM",
        billingMode: "subscription",
      }),
    ]);
  });

  it("leaves OAuth-connected dual providers to /model-providers/models", async () => {
    const app = await appWithRuntime(runtimeWith({ anthropic: "oauth", xai: "api_key" }));
    const direct = await app.inject({ method: "GET", url: "/providers/models" });
    expect(direct.json().models.map((m: { id: string }) => m.id)).toEqual(["xai/xai-model"]);
    expect(direct.json().models[0].billingMode).toBe("payg");
    const oauth = await app.inject({ method: "GET", url: "/model-providers/models" });
    expect(oauth.json().models.map((m: { id: string }) => m.id)).toEqual([
      "anthropic/anthropic-model",
    ]);
    expect(oauth.json().models[0].billingMode).toBe("metered_oauth");
  });

  it("never lists OpenRouter's Pi catalogue under /model-providers/models", async () => {
    const app = await appWithRuntime(runtimeWith({ openrouter: "oauth" }));
    const status = await app.inject({ method: "GET", url: "/model-providers" });
    expect(status.json().providers).toContainEqual(
      expect.objectContaining({ id: "openrouter", connected: true, billingMode: "payg" }),
    );
    const models = await app.inject({ method: "GET", url: "/model-providers/models" });
    expect(models.json().models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Credentials: configuration values
// ---------------------------------------------------------------------------

describe("PUT /credentials for direct-provider fields", () => {
  const saved = new Map<string, string | undefined>();
  const touched = ["GROQ_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "GOOGLE_CLOUD_LOCATION", "MOONSHOT_API_KEY"];

  afterEach(() => {
    for (const name of touched) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setCredentialEnvPathForTests(null);
  });

  async function app() {
    for (const name of touched) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-cred-"));
    setCredentialEnvPathForTests(path.join(dir, ".env"));
    const instance = Fastify();
    apps.push(instance);
    await registerCredentialRoutes(instance);
    return { instance, envPath: path.join(dir, ".env") };
  }

  it("maps every catalogue env var to a managed credential", () => {
    for (const envVar of directProviderEnvVars()) {
      expect(credentialFieldFor(envVar), envVar).toBeDefined();
    }
    expect(credentialFieldFor("GEMINI_API_KEY")).toEqual({
      credentialId: "gemini",
      bodyField: "geminiApiKey",
    });
    expect(credentialFieldFor("CLOUDFLARE_ACCOUNT_ID")).toEqual({
      credentialId: "CLOUDFLARE_ACCOUNT_ID",
      bodyField: "CLOUDFLARE_ACCOUNT_ID",
    });
  });

  it("accepts short configuration values and echoes them unmasked", async () => {
    const { instance, envPath } = await app();
    const response = await instance.inject({
      method: "PUT",
      url: "/credentials",
      payload: { GOOGLE_CLOUD_LOCATION: "global", CLOUDFLARE_ACCOUNT_ID: "abc123def" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().GOOGLE_CLOUD_LOCATION).toEqual({ set: true, masked: "global" });
    expect(response.json().CLOUDFLARE_ACCOUNT_ID).toEqual({ set: true, masked: "abc123def" });
    expect(process.env.GOOGLE_CLOUD_LOCATION).toBe("global");
    expect(fs.readFileSync(envPath, "utf-8")).toContain("GOOGLE_CLOUD_LOCATION=global");
  });

  it("still rejects short secrets and masks stored keys", async () => {
    const { instance } = await app();
    const short = await instance.inject({
      method: "PUT",
      url: "/credentials",
      payload: { groqApiKey: "gsk_1" },
    });
    expect(short.statusCode).toBe(400);
    const ok = await instance.inject({
      method: "PUT",
      url: "/credentials",
      payload: { groqApiKey: "gsk_abcdefghijklmnop" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().groq.set).toBe(true);
    expect(ok.json().groq.masked).not.toContain("abcdefghijkl");
  });
});
