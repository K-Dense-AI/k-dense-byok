import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  buildEdenaiModel,
  edenaiApiKey,
  edenaiCatalogue,
  edenaiConfigured,
  edenaiPickerModels,
  explainEdenaiError,
  fetchEdenaiModels,
  invalidateEdenaiCatalogue,
  isEdenaiEndpointMismatch,
  isEdenaiRef,
  noteEdenaiEndpointMismatch,
  parseEdenaiModels,
  resetEdenaiEndpointStateForTests,
  setEdenaiCatalogueForTests,
  stripEdenaiRef,
  type EdenaiModelInfo,
} from "../src/agent/edenai.ts";
import {
  ModelAuthenticationError,
  ModelResolutionError,
  assertModelAuthentication,
  modelReference,
  resolveModel,
} from "../src/agent/models.ts";
import { edenaiModelForClient } from "../src/agent/provider-auth.ts";
import { getModelRegistry, getModelRuntime } from "../src/agent/session-registry.ts";
import {
  billingCountsTowardBudget,
  billingForModel,
  billingForProvider,
} from "../src/cost/billing.ts";
import { emptySnapshot, recordRun, sessionCostSummary } from "../src/cost/ledger.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";
import {
  makeSubagentLedgerExtension,
  pinInheritedChildModels,
} from "../src/agent/subagent-bridge.ts";

// Eden AI is a paid OpenAI-compatible gateway: ~1000 models under
// "<vendor>/<model>" ids (often with more slashes), real per-token USD pricing
// discovered from its own /v3/models, and no Pi built-in catalogue entry.

const GPT_4O_MINI = "openai/gpt-4o-mini";
// A real Eden id with more than one slash — the case that breaks any resolver
// that splits a ref instead of stripping the prefix.
const DEEP_ID = "fireworks_ai/accounts/fireworks/models/glm-5p3";

function info(overrides: Partial<EdenaiModelInfo> = {}): EdenaiModelInfo {
  return {
    id: GPT_4O_MINI,
    label: "gpt-4o-mini",
    ownedBy: "openai",
    contextWindow: 128_000,
    costInput: 0.15,
    costOutput: 0.6,
    cacheRead: 0.075,
    cacheWrite: 0,
    input: ["text"],
    reasoning: false,
    functionCalling: true,
    ...overrides,
  };
}

afterEach(() => {
  setEdenaiCatalogueForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Model refs
// ---------------------------------------------------------------------------

describe("Eden AI model refs", () => {
  const registry = getModelRegistry();

  it("resolves edenai/<vendor>/<model> to the edenai provider and bare Eden id", () => {
    setEdenaiCatalogueForTests([info()]);
    const model = resolveModel(`edenai/${GPT_4O_MINI}`, registry);

    expect(model.provider).toBe("edenai");
    expect(model.id).toBe(GPT_4O_MINI);
    expect(model.baseUrl).toBe("https://api.edenai.run/v3");
    expect(modelReference(model)).toBe(`edenai/${GPT_4O_MINI}`);
  });

  // Eden ids like fireworks_ai/accounts/fireworks/models/x carry four slashes.
  // Only the leading "edenai/" may be removed; the API needs the rest verbatim.
  it("strips only the first edenai/ segment from a multi-slash id", () => {
    setEdenaiCatalogueForTests([info({ id: DEEP_ID })]);
    const model = resolveModel(`edenai/${DEEP_ID}`, registry);

    expect(model.id).toBe(DEEP_ID);
    expect(modelReference(model)).toBe(`edenai/${DEEP_ID}`);
    expect(stripEdenaiRef(`edenai/${DEEP_ID}`)).toBe(DEEP_ID);
  });

  // An Eden id can itself begin with a vendor segment; only one prefix goes.
  it("leaves a nested edenai/ segment inside the id alone", () => {
    expect(stripEdenaiRef("edenai/edenai/some-model")).toBe("edenai/some-model");
    expect(isEdenaiRef("edenai/x")).toBe(true);
    expect(isEdenaiRef("openrouter/edenai/x")).toBe(false);
  });

  it("rejects a bare edenai/ ref with no model id", () => {
    expect(() => resolveModel("edenai/", registry)).toThrowError(ModelResolutionError);
  });

  it("applies discovered metadata: pricing per 1M, context, reasoning, modality", () => {
    setEdenaiCatalogueForTests([
      info({
        id: "anthropic/claude-sonnet-4-5",
        label: "claude-sonnet-4-5",
        contextWindow: 200_000,
        costInput: 3,
        costOutput: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        input: ["text", "image"],
        reasoning: true,
      }),
    ]);
    const model = resolveModel("edenai/anthropic/claude-sonnet-4-5", registry);

    expect(model.name).toBe("claude-sonnet-4-5");
    expect(model.contextWindow).toBe(200_000);
    expect(model.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    // Eden publishes no per-model output cap, so every model takes the default.
    expect(model.maxTokens).toBe(8192);
  });

  // Pi computes usage.cost from model.cost, so an unpriced model silently stops
  // the project spend cap from accruing. It must still run, but must be loud.
  it("warns when it has to price an undiscovered model at $0", () => {
    setEdenaiCatalogueForTests(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const model = resolveModel("edenai/vendor/never-discovered", registry);

    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spend limit"));
    warn.mockRestore();
  });
});

// The resolver's Eden branch sits above the "unknown prefix means OpenRouter"
// fallback. If it were below, "edenai/openai/gpt-4o-mini" would be sent to
// OpenRouter as a vendor id — unpriced, and against the wrong account.
describe("OpenRouter resolution is unchanged", () => {
  const registry = getModelRegistry();

  it("still resolves an explicit openrouter/ ref to OpenRouter", () => {
    const model = resolveModel("openrouter/anthropic/claude-opus-5", registry);
    expect(model.provider).toBe("openrouter");
    expect(model.id).toBe("anthropic/claude-opus-5");
    expect(model.baseUrl).toContain("openrouter.ai");
  });

  it("still treats a bare vendor ref as an OpenRouter model", () => {
    const model = resolveModel("meta-llama/llama-3.3-70b", registry);
    expect(model.provider).toBe("openrouter");
    expect(model.id).toBe("meta-llama/llama-3.3-70b");
  });

  it("does not claim a ref that merely contains edenai further along", () => {
    const model = resolveModel("openrouter/edenai/whatever", registry);
    expect(model.provider).toBe("openrouter");
    expect(model.id).toBe("edenai/whatever");
  });
});

// ---------------------------------------------------------------------------
// Wire compatibility (see EDENAI_COMPAT in agent/edenai.ts)
// ---------------------------------------------------------------------------

describe("Eden AI request compatibility", () => {
  it("pins the four settings Pi would otherwise mis-detect for an unknown host", () => {
    const model = buildEdenaiModel(GPT_4O_MINI, info({ reasoning: true }));
    const compat = (model as Model<"openai-completions">).compat!;

    // Eden documents system/user/assistant/tool — not OpenAI's `developer`,
    // which Pi sends for the system prompt on reasoning models by default.
    expect(compat.supportsDeveloperRole).toBe(false);
    // `store` is not in Eden's documented request schema.
    expect(compat.supportsStore).toBe(false);
    // Eden documents both fields; max_tokens is what every upstream accepts.
    expect(compat.maxTokensField).toBe("max_tokens");
    // `strict` is not documented, so tool definitions omit it entirely.
    expect(compat.supportsStrictMode).toBe(false);
    // reasoning_effort *is* documented, as a top-level string ("openai").
    expect(compat.supportsReasoningEffort).toBe(true);
    expect(compat.thinkingFormat).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** One row shaped exactly like Eden's live /v3/models payload. */
function edenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GPT_4O_MINI,
    object: "model",
    created: 1_742_000_000,
    owned_by: "openai",
    model_name: "gpt-4o-mini",
    context_length: 128_000,
    description: "A long upstream description that the picker never renders.",
    source: null,
    capabilities: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supports_reasoning: false,
      supports_function_calling: true,
      supports_system_messages: true,
      supports_native_streaming: true,
    },
    pricing: {
      input_cost_per_token: 1.5e-7,
      output_cost_per_token: 6e-7,
      cache_read_input_token_cost: 7.5e-8,
    },
    list_pricing: {
      // Deliberately different: the effective (discounted) pricing is what the
      // account is charged, so it is what the ledger must use.
      input_cost_per_token: 3e-7,
      output_cost_per_token: 1.2e-6,
    },
    discount: 0.5,
    regions: [{ code: "global", name: "Global" }],
    alias_of: null,
    ...overrides,
  };
}

describe("parseEdenaiModels", () => {
  it("converts per-token pricing to Pi's USD per 1M tokens", () => {
    const [model] = parseEdenaiModels({ data: [edenRow()] });

    expect(model.costInput).toBeCloseTo(0.15, 10);
    expect(model.costOutput).toBeCloseTo(0.6, 10);
    expect(model.cacheRead).toBeCloseTo(0.075, 10);
    // Absent keys are 0, not NaN — a NaN cost would poison the ledger.
    expect(model.cacheWrite).toBe(0);
  });

  it("prices from `pricing`, never `list_pricing`", () => {
    const [model] = parseEdenaiModels({ data: [edenRow()] });
    expect(model.costInput).toBeCloseTo(0.15, 10);
    expect(model.costInput).not.toBeCloseTo(0.3, 10);
  });

  it("reads capabilities, modalities, and a multi-slash id", () => {
    const models = parseEdenaiModels({
      data: [
        edenRow(),
        edenRow({
          id: DEEP_ID,
          model_name: "glm-5p3",
          capabilities: {
            input_modalities: ["text"],
            supports_reasoning: true,
            supports_function_calling: false,
          },
        }),
      ],
    });

    expect(models[0].id).toBe(GPT_4O_MINI);
    expect(models[0].input).toEqual(["text", "image"]);
    expect(models[0].reasoning).toBe(false);
    expect(models[0].functionCalling).toBe(true);

    expect(models[1].id).toBe(DEEP_ID);
    expect(models[1].input).toEqual(["text"]);
    expect(models[1].reasoning).toBe(true);
    expect(models[1].functionCalling).toBe(false);
  });

  // Eden reports context_length: null for a minority of rows and carries a long
  // tail of optional pricing keys; one odd row must not blank the catalogue.
  it("survives missing fields and skips rows without an id", () => {
    const models = parseEdenaiModels({
      data: [
        edenRow({ id: "vendor/no-context", context_length: null, model_name: null }),
        edenRow({ id: "", model_name: "no id" }),
        { object: "model" },
        null,
        edenRow({ id: "vendor/no-context" }), // duplicate id
        edenRow({ id: "vendor/tiered", pricing: { tiered_pricing: [{ range: [0, 1] }] } }),
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["vendor/no-context", "vendor/tiered"]);
    expect(models[0].contextWindow).toBe(128_000);
    expect(models[0].label).toBe("vendor/no-context");
    expect(models[1].costInput).toBe(0);
  });

  it("returns [] for a payload with no data array", () => {
    expect(parseEdenaiModels({})).toEqual([]);
    expect(parseEdenaiModels(null)).toEqual([]);
  });
});

describe("fetchEdenaiModels", () => {
  it("calls Eden's documented endpoint with the key as a bearer token", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [edenRow()] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchEdenaiModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.edenai.run/v3/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer eden-secret-key",
    );
    expect(models).toHaveLength(1);
  });

  it("throws with the status when Eden rejects the request", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );

    await expect(fetchEdenaiModels()).rejects.toThrow(/HTTP 401/);
  });

  it("refuses to call Eden without a key", async () => {
    vi.stubEnv("EDENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEdenaiModels()).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(edenaiConfigured()).toBe(false);
    expect(edenaiApiKey()).toBeNull();
  });
});

describe("edenaiCatalogue caching", () => {
  beforeEach(() => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    invalidateEdenaiCatalogue();
    setEdenaiCatalogueForTests(null); // also blocks the on-disk snapshot
  });

  it("fetches once and serves later reads from cache", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [edenRow()] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await edenaiCatalogue();
    const second = await edenaiCatalogue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("shares one upstream request between concurrent callers", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [edenRow()] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([edenaiCatalogue(), edenaiCatalogue(), edenaiCatalogue()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-discovers after the key changes (invalidate)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [edenRow()] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await edenaiCatalogue();
    invalidateEdenaiCatalogue();
    setEdenaiCatalogueForTests(null);
    await edenaiCatalogue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous catalogue when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [edenRow()] }), { status: 200 })),
    );
    await edenaiCatalogue();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(edenaiCatalogue(true)).rejects.toThrow(/HTTP 500/);

    // A failed refresh must not empty the picker.
    expect(buildEdenaiModel(GPT_4O_MINI).cost.input).toBeCloseTo(0.15, 10);
  });
});

describe("edenaiPickerModels", () => {
  // Kady attaches tool definitions to every turn, so a model that cannot do
  // function calling cannot run the agent loop. Same rule the checked-in
  // OpenRouter catalogue is generated with.
  it("offers only tool-calling models, but the cache keeps the rest priced", () => {
    const catalogue = [
      info({ id: "a/tools", functionCalling: true }),
      info({ id: "b/no-tools", functionCalling: false, costInput: 9 }),
    ];
    setEdenaiCatalogueForTests(catalogue);

    expect(edenaiPickerModels(catalogue).map((m) => m.id)).toEqual(["a/tools"]);
    // A persisted ref to the excluded model still resolves at its real price.
    expect(buildEdenaiModel("b/no-tools").cost.input).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Billing: Eden charges real per-token USD, unlike NIM's provider credits
// ---------------------------------------------------------------------------

describe("Eden AI billing policy", () => {
  it("is pay-as-you-go, so usage counts against the project spend cap", () => {
    const billing = billingForProvider("edenai", "api_key");
    expect(billing).toEqual({
      provider: "edenai",
      authType: "api_key",
      billingMode: "payg",
    });
    expect(billingCountsTowardBudget(billing)).toBe(true);
  });

  it("classifies a resolved Eden model as payg", async () => {
    setEdenaiCatalogueForTests([info()]);
    const model = resolveModel(`edenai/${GPT_4O_MINI}`, getModelRegistry());
    const runtime = {
      checkAuth: vi.fn(async () => ({ type: "api_key" as const, source: "EDENAI_API_KEY" })),
    };

    const billing = await billingForModel(model, runtime as never);

    expect(runtime.checkAuth).toHaveBeenCalledWith("edenai");
    expect(billing.billingMode).toBe("payg");
  });

  it("ledgers a run on an Eden model as payg spend", () => {
    createProject({ name: "Eden", projectId: "edenai-ledger" });
    resolvePaths("edenai-ledger");

    const entry = recordRun({
      sessionId: "s1",
      projectId: "edenai-ledger",
      model: `edenai/${GPT_4O_MINI}`,
      before: emptySnapshot(),
      after: { ...emptySnapshot(), input: 10, output: 5, total: 15, costUsd: 0.25 },
    });

    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe("edenai");
    expect(entry!.billingMode).toBe("payg");
    expect(entry!.costUsd).toBeCloseTo(0.25, 10);
  });

  // Subagent billing is derived on its own code path from the child's ref.
  it("ledgers a subagent run on an Eden model as payg spend", async () => {
    createProject({ name: "Eden sub", projectId: "edenai-sub" });
    const handlers = new Map<string, (event: any) => any>();
    const extension = makeSubagentLedgerExtension(
      "edenai-sub",
      () => "parent-session",
      () =>
        ({
          provider: "openrouter",
          id: "anthropic/claude-opus-5",
        }) as Parameters<typeof pinInheritedChildModels>[2],
      () => false,
    );
    extension({
      on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
      events: { on: () => {} },
    } as any);

    await handlers.get("tool_result")!({
      toolName: "subagent",
      details: {
        results: [
          {
            modelAttempts: [
              {
                model: `edenai/${GPT_4O_MINI}`,
                usage: { input: 30, output: 10, cost: 0.5 },
              },
            ],
          },
        ],
      },
    });

    const summary = sessionCostSummary("parent-session", "edenai-sub");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].billingMode).toBe("payg");
    expect(summary.totalUsd).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// Provider auth
// ---------------------------------------------------------------------------

describe("Eden AI provider auth", () => {
  it("accepts an API key (it is not an OAuth-only subscription provider)", async () => {
    setEdenaiCatalogueForTests([info()]);
    const model = resolveModel(`edenai/${GPT_4O_MINI}`, getModelRegistry());
    const runtime = {
      checkAuth: async () => ({ type: "api_key" as const, source: "EDENAI_API_KEY" }),
    };

    await expect(
      assertModelAuthentication(
        model,
        runtime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).resolves.toBeUndefined();
  });

  it("names Settings in the error when no key is configured", async () => {
    setEdenaiCatalogueForTests([info()]);
    const model = resolveModel(`edenai/${GPT_4O_MINI}`, getModelRegistry());
    const runtime = { checkAuth: async () => undefined };

    await expect(
      assertModelAuthentication(
        model,
        runtime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).rejects.toThrowError(ModelAuthenticationError);
    await expect(
      assertModelAuthentication(
        model,
        runtime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).rejects.toThrowError(/Eden AI is not configured/);
  });

  // Registering with `apiKey: ""` would make Pi report Eden as configured
  // forever, turning a missing key into an opaque mid-run 401. The provider is
  // therefore registered with no key at all, and the credential is injected at
  // runtime — this asserts both halves of that arrangement.
  it("registers unconfigured, then becomes configured via the runtime key", async () => {
    const runtime = getModelRuntime();
    expect(runtime.getProvider("edenai")?.name).toBe("Eden AI");
    expect(await runtime.checkAuth("edenai")).toBeUndefined();

    await runtime.setRuntimeApiKey("edenai", "eden-runtime-key");
    try {
      expect(await runtime.checkAuth("edenai")).toMatchObject({ type: "api_key" });
    } finally {
      await runtime.removeRuntimeApiKey("edenai");
    }
    expect(await runtime.checkAuth("edenai")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /edenai/models
// ---------------------------------------------------------------------------

describe("GET /edenai/models", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  async function buildApp() {
    const app = Fastify();
    apps.push(app);
    // The Eden route reads its own catalogue module; the injected runtime only
    // satisfies the subscription-provider routes registered alongside it.
    await registerModelProviderRoutes(app, {
      runtime: {
        login: vi.fn(),
        logout: vi.fn(async () => {}),
        checkAuth: vi.fn(async () => undefined),
        getAuth: vi.fn(async () => undefined),
        listCredentials: vi.fn(async () => []),
        getAvailable: vi.fn(async () => []),
        getProvider: vi.fn(() => undefined),
      } as never,
    });
    return app;
  }

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it("returns picker-shaped, tool-calling models once a key is configured", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    setEdenaiCatalogueForTests([
      info(),
      info({ id: DEEP_ID, label: "glm-5p3", functionCalling: false }),
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/edenai/models" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configured).toBe(true);
    expect(body.models).toEqual([
      {
        id: `edenai/${GPT_4O_MINI}`,
        label: "gpt-4o-mini",
        provider: "Eden AI",
        sourceId: "edenai",
        sourceLabel: "Eden AI",
        tier: "budget",
        context_length: 128_000,
        pricing: { prompt: 0.15, completion: 0.6 },
        modality: "text->text",
        description: `Eden AI gateway → ${GPT_4O_MINI}`,
        reasoning: false,
        billingMode: "payg",
        available: true,
      },
    ]);
  });

  it("keeps the multi-slash id intact in the picker ref", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    setEdenaiCatalogueForTests([info({ id: DEEP_ID, label: "glm-5p3" })]);
    const app = await buildApp();

    const body = (await app.inject({ url: "/edenai/models" })).json();

    expect(body.models[0].id).toBe(`edenai/${DEEP_ID}`);
  });

  // Hiding the section for everyone without a key is why `configured` exists,
  // and Eden must never be contacted before there is a credential to send.
  it("stays hidden and contacts nothing without a key", async () => {
    vi.stubEnv("EDENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp();

    const response = await app.inject({ url: "/edenai/models" });

    expect(response.json()).toEqual({ configured: false, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a discovery failure instead of an empty section", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-secret-key");
    invalidateEdenaiCatalogue();
    setEdenaiCatalogueForTests(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const app = await buildApp();

    const body = (await app.inject({ url: "/edenai/models" })).json();

    expect(body.configured).toBe(true);
    expect(body.models).toEqual([]);
    expect(body.error).toMatch(/HTTP 401/);
  });
});

// ---------------------------------------------------------------------------
// Responses-API-only models
//
// Observed live: a chat request to `azure/gpt-5-pro` returns
//   400 {"message":"Model(s) do not support /chat/completions:
//        'azure/gpt-5-pro' (supports: /responses)", ...}
// and nothing in `/v3/models` distinguishes such a model — only 1 of ~1000
// rows carries any supports_*_api flag, the filter query params are ignored,
// and there is no per-model route. So the gateway's own rejection is the only
// available signal, and it is learned rather than guessed from the id.
// ---------------------------------------------------------------------------

const ENDPOINT_ERROR =
  `400: {"message":"Model(s) do not support /chat/completions: ` +
  `'azure/gpt-5-pro' (supports: /responses)","type":"invalid_request_error",` +
  `"param":null,"code":"invalid_parameter"}`;

describe("Eden AI Responses-API-only models", () => {
  beforeEach(() => {
    resetEdenaiEndpointStateForTests();
  });

  afterEach(() => {
    resetEdenaiEndpointStateForTests();
  });

  it("recognizes the endpoint rejection and nothing else", () => {
    expect(isEdenaiEndpointMismatch(ENDPOINT_ERROR)).toBe(true);
    expect(isEdenaiEndpointMismatch("400: rate limit exceeded")).toBe(false);
    expect(isEdenaiEndpointMismatch("Provider finish_reason: content_filter")).toBe(false);
    expect(isEdenaiEndpointMismatch(undefined)).toBe(false);
  });

  it("explains what to do and keeps the gateway's own message", () => {
    const explained = explainEdenaiError(ENDPOINT_ERROR, "edenai/azure/gpt-5-pro");

    expect(explained).toContain(ENDPOINT_ERROR);
    expect(explained).toContain("Responses API");
    expect(explained).toContain("edenai/azure/gpt-5-pro");
    expect(explained).toContain("Pick another Eden AI model");
  });

  it("passes unrelated errors through untouched", () => {
    expect(explainEdenaiError("400: rate limit exceeded", "edenai/openai/gpt-4o-mini")).toBe(
      "400: rate limit exceeded",
    );
  });

  it("drops the rejected model from the picker, keeping the rest", () => {
    const catalogue = [
      info({ id: "azure/gpt-5-pro" }),
      info({ id: GPT_4O_MINI }),
      // A different vendor's "pro" tier: an ordinary chat model that must NOT
      // be excluded by any id heuristic.
      info({ id: "google/gemini-3.1-pro" }),
    ];

    expect(edenaiPickerModels(catalogue).map((m) => m.id)).toEqual([
      "azure/gpt-5-pro",
      GPT_4O_MINI,
      "google/gemini-3.1-pro",
    ]);

    explainEdenaiError(ENDPOINT_ERROR, "edenai/azure/gpt-5-pro");

    expect(edenaiPickerModels(catalogue).map((m) => m.id)).toEqual([
      GPT_4O_MINI,
      "google/gemini-3.1-pro",
    ]);
  });

  // The message is authoritative: a turn can name a model other than the
  // chat's own (a subagent, or a multi-model rejection).
  it("learns every id the message quotes, not just the run's model", () => {
    const catalogue = [
      info({ id: "azure/gpt-5-pro" }),
      info({ id: "openai/gpt-5.5-pro" }),
      info({ id: GPT_4O_MINI }),
    ];
    const message =
      "Model(s) do not support /chat/completions: 'azure/gpt-5-pro', " +
      "'openai/gpt-5.5-pro' (supports: /responses)";

    expect(noteEdenaiEndpointMismatch(message)).toEqual([
      "azure/gpt-5-pro",
      "openai/gpt-5.5-pro",
    ]);
    expect(edenaiPickerModels(catalogue).map((m) => m.id)).toEqual([GPT_4O_MINI]);
  });

  it("falls back to the run's ref when the message quotes no id", () => {
    const message = "Model(s) do not support /chat/completions (supports: /responses)";
    expect(noteEdenaiEndpointMismatch(message, "edenai/azure/gpt-5-pro")).toEqual([
      "azure/gpt-5-pro",
    ]);
  });

  // An excluded model is still resolvable and correctly priced: the ledger
  // must not lose track of a ref a user pinned in a subagent or DEFAULT_MODEL_ID.
  it("keeps a rejected model resolvable and priced", () => {
    setEdenaiCatalogueForTests([info({ id: "azure/gpt-5-pro", costInput: 15 })]);
    explainEdenaiError(ENDPOINT_ERROR, "edenai/azure/gpt-5-pro");

    const model = resolveModel("edenai/azure/gpt-5-pro", getModelRegistry());
    expect(model.provider).toBe("edenai");
    expect(model.cost.input).toBe(15);
  });
});

describe("edenaiModelForClient", () => {
  it("marks Eden entries as cap-counted pay-as-you-go", () => {
    const client = edenaiModelForClient(
      buildEdenaiModel(GPT_4O_MINI, info({ costOutput: 25, input: ["text", "image"] })),
    );

    expect(client.billingMode).toBe("payg");
    expect(client.sourceId).toBe("edenai");
    expect(client.modality).toBe("text+image->text");
    // Tiers come from real output pricing, so they are meaningful here.
    expect(client.tier).toBe("flagship");
  });
});

// ---------------------------------------------------------------------------
// End-to-end wire behaviour against a stub Eden gateway.
//
// This drives the real ModelRuntime, the real Pi openai-completions adapter,
// and the production Model (compat block included) — only `baseUrl` is
// redirected at a local server. It is what verifies the streaming, tool-call,
// role, and credential behaviour rather than asserting it.
// ---------------------------------------------------------------------------

describe("Eden AI over the wire (stub gateway)", () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: { path: string; auth?: string; body: any }[];
  /** Set per test: the SSE chunks the stub streams back. */
  let chunks: unknown[];

  function sse(res: http.ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  beforeEach(async () => {
    requests = [];
    chunks = [];
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => {
        raw += part;
      });
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          body: raw ? JSON.parse(raw) : null,
        });
        sse(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await getModelRuntime().setRuntimeApiKey("edenai", "eden-wire-key");
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await getModelRuntime().removeRuntimeApiKey("edenai");
  });

  /** The production Eden model, pointed at the stub gateway. */
  function stubModel(overrides: Partial<EdenaiModelInfo> = {}): Model<Api> {
    const model = buildEdenaiModel(overrides.id ?? GPT_4O_MINI, info(overrides));
    return { ...model, baseUrl };
  }

  function textChunk(delta: string, finish: string | null = null) {
    return {
      id: "chatcmpl-eden-1",
      object: "chat.completion.chunk",
      created: 1_742_000_001,
      model: GPT_4O_MINI,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: finish }],
    };
  }

  it("streams SSE deltas incrementally and terminates on [DONE]", async () => {
    chunks = [
      {
        id: "chatcmpl-eden-1",
        object: "chat.completion.chunk",
        created: 1_742_000_001,
        model: GPT_4O_MINI,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      },
      textChunk("A hash table "),
      textChunk("maps keys "),
      textChunk("to values.", "stop"),
      {
        id: "chatcmpl-eden-1",
        object: "chat.completion.chunk",
        created: 1_742_000_001,
        model: GPT_4O_MINI,
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      },
    ];

    const stream = getModelRuntime().stream(stubModel(), {
      systemPrompt: "You are Kady.",
      messages: [
        { role: "user", content: "Explain what a hash table is.", timestamp: Date.now() },
      ],
    } satisfies Context);

    const deltas: string[] = [];
    let done: any;
    for await (const event of stream) {
      if (event.type === "text_delta") deltas.push(event.delta);
      if (event.type === "done") done = event;
      if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
    }

    // Incremental delivery, not one final blob.
    expect(deltas).toEqual(["A hash table ", "maps keys ", "to values."]);
    expect(done.reason).toBe("stop");
    expect(done.message.content[0]).toMatchObject({
      type: "text",
      text: "A hash table maps keys to values.",
    });
    // stream_options: {include_usage: true} is what makes this arrive at all.
    expect(done.message.usage).toMatchObject({ input: 12, output: 7 });
    // Pi prices the turn from model.cost, so real Eden pricing lands here.
    expect(done.message.usage.cost.total).toBeGreaterThan(0);
  });

  it("sends the credential, the full Eden model id, and only documented params", async () => {
    chunks = [textChunk("ok", "stop")];

    await getModelRuntime().complete(
      stubModel({ id: DEEP_ID }),
      {
        systemPrompt: "You are Kady.",
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      },
      { maxTokens: 1234 },
    );

    expect(requests).toHaveLength(1);
    const [request] = requests;
    // Eden's documented endpoint is <base>/chat/completions.
    expect(request.path).toBe("/chat/completions");
    expect(request.auth).toBe("Bearer eden-wire-key");
    // The multi-slash id reaches the API whole, with no edenai/ prefix.
    expect(request.body.model).toBe(DEEP_ID);
    expect(request.body.stream).toBe(true);
    expect(request.body.stream_options).toEqual({ include_usage: true });
    // maxTokensField: "max_tokens"
    expect(request.body.max_tokens).toBe(1234);
    expect(request.body).not.toHaveProperty("max_completion_tokens");
    // supportsStore: false
    expect(request.body).not.toHaveProperty("store");
  });

  // Eden documents system/user/assistant/tool. Without the compat override Pi
  // would send the system prompt as role "developer" on any reasoning model.
  it("uses the system role, never developer, even for a reasoning model", async () => {
    chunks = [textChunk("ok", "stop")];

    await getModelRuntime().complete(
      stubModel({ reasoning: true }),
      {
        systemPrompt: "You are Kady.",
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      },
      { reasoningEffort: "high" },
    );

    const roles = requests[0].body.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user"]);
    expect(roles).not.toContain("developer");
    // reasoning_effort is Eden-documented and passes through as a plain string.
    expect(requests[0].body.reasoning_effort).toBe("high");
  });

  it("sends no reasoning parameter for a non-reasoning model", async () => {
    chunks = [textChunk("ok", "stop")];

    await getModelRuntime().complete(stubModel({ reasoning: false }), {
      systemPrompt: "You are Kady.",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });

    expect(requests[0].body).not.toHaveProperty("reasoning_effort");
    expect(requests[0].body).not.toHaveProperty("thinking");
  });

  const weatherTool = {
    name: "get_weather",
    description: "Look up the weather for a city.",
    parameters: Type.Object({ city: Type.String() }),
  };

  it("sends OpenAI-shaped tool definitions without the undocumented strict flag", async () => {
    chunks = [textChunk("ok", "stop")];

    await getModelRuntime().complete(
      stubModel(),
      {
        systemPrompt: "You are Kady.",
        messages: [{ role: "user", content: "weather in Paris?", timestamp: Date.now() }],
        tools: [weatherTool],
      },
      { toolChoice: "auto" },
    );

    expect(requests[0].body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather for a city.",
          parameters: expect.objectContaining({ type: "object" }),
        },
      },
    ]);
    expect(requests[0].body.tools[0].function).not.toHaveProperty("strict");
    expect(requests[0].body.tool_choice).toBe("auto");
  });

  it("parses streamed tool calls with their arguments intact", async () => {
    chunks = [
      {
        id: "chatcmpl-eden-2",
        object: "chat.completion.chunk",
        created: 1_742_000_002,
        model: GPT_4O_MINI,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_eden_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Arguments arrive split across chunks, as they do on the real wire.
      {
        id: "chatcmpl-eden-2",
        object: "chat.completion.chunk",
        created: 1_742_000_002,
        model: GPT_4O_MINI,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-eden-2",
        object: "chat.completion.chunk",
        created: 1_742_000_002,
        model: GPT_4O_MINI,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const message = await getModelRuntime().complete(stubModel(), {
      systemPrompt: "You are Kady.",
      messages: [{ role: "user", content: "weather in Paris?", timestamp: Date.now() }],
      tools: [weatherTool],
    });

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        id: "call_eden_1",
        name: "get_weather",
        arguments: { city: "Paris" },
      }),
    ]);
  });

  it("replays a tool result as a tool-role message and continues the turn", async () => {
    chunks = [textChunk("It is 18°C in Paris.", "stop")];

    const message = await getModelRuntime().complete(stubModel(), {
      systemPrompt: "You are Kady.",
      messages: [
        { role: "user", content: "weather in Paris?", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_eden_1",
              name: "get_weather",
              arguments: { city: "Paris" },
            },
          ],
          api: "openai-completions",
          provider: "edenai",
          model: GPT_4O_MINI,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as never,
        {
          role: "toolResult",
          toolCallId: "call_eden_1",
          toolName: "get_weather",
          content: [{ type: "text", text: "18C, clear" }],
          isError: false,
          timestamp: Date.now(),
        } as never,
      ],
      tools: [weatherTool],
    });

    const sent = requests[0].body.messages;
    const toolMessage = sent.find((m: { role: string }) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      tool_call_id: "call_eden_1",
      content: "18C, clear",
    });
    expect(message.content[0]).toMatchObject({ text: "It is 18°C in Paris." });
  });

  it("surfaces a content_filter finish as a provider refusal, not silent success", async () => {
    chunks = [
      {
        id: "chatcmpl-eden-3",
        object: "chat.completion.chunk",
        created: 1_742_000_003,
        model: GPT_4O_MINI,
        choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
      },
    ];

    const message = await getModelRuntime().complete(stubModel(), {
      systemPrompt: "You are Kady.",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });

    // Kady's refusal guidance keys off this string (agent/model-refusal.ts).
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/content_filter/);
  });
});
