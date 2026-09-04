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
  normalizeUsageCost,
} from "../src/cost/billing.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  projectCostSummary,
  recordRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
} from "../src/cost/ledger.ts";
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

// ---------------------------------------------------------------------------
// Billing end-to-end: Eden /v3/models pricing → Pi Model.cost → usage.cost →
// ledger row → project spend cap.
//
// The tests above prove the *classification* (payg) and the *parse* (per-token
// → per-1M). Neither proves that a real streamed turn's token counts end up as
// the right number of dollars in costs.jsonl, which is the only thing the
// spend cap actually reads. These tests run that whole chain against a stub
// gateway, using the same functions `api/sessions.ts` uses on a real run:
//
//   parseEdenaiModels → setEdenaiCatalogueForTests → resolveModel
//     → ModelRuntime.stream (pi-ai prices the turn via calculateCost)
//     → addTurnUsage / snapshotDelta / snapshotMax   (sessions.ts, turn_end)
//     → recordRun with billingForModel               (sessions.ts, finally)
//     → sessionCostSummary / projectCostSummary / isBudgetExceeded
// ---------------------------------------------------------------------------

/**
 * A deterministic priced Eden catalogue row, expressed the way Eden's
 * `/v3/models` actually expresses it: USD *per token*.
 */
function pricedRow(
  id: string,
  perMillion: { input: number; output: number; cacheRead?: number },
) {
  return edenRow({
    id,
    model_name: id,
    pricing: {
      input_cost_per_token: perMillion.input / 1_000_000,
      output_cost_per_token: perMillion.output / 1_000_000,
      ...(perMillion.cacheRead !== undefined
        ? { cache_read_input_token_cost: perMillion.cacheRead / 1_000_000 }
        : {}),
    },
    // Always double the effective price, so any test that accidentally read
    // `list_pricing` would come out at exactly 2x and fail loudly.
    list_pricing: {
      input_cost_per_token: (perMillion.input * 2) / 1_000_000,
      output_cost_per_token: (perMillion.output * 2) / 1_000_000,
    },
  });
}

describe("Eden AI billing end-to-end (stub gateway to ledger and spend cap)", () => {
  let server: http.Server;
  let baseUrl: string;
  let chunks: unknown[];
  let requests: { path: string; body: any }[];

  // $0.50 / 1M input, $1.50 / 1M output - the worked example being verified.
  const IN_PER_M = 0.5;
  const OUT_PER_M = 1.5;
  const INPUT_TOKENS = 1_000;
  const OUTPUT_TOKENS = 2_000;
  // 1000/1e6 x 0.50 + 2000/1e6 x 1.50
  const EXPECTED_USD = 0.0035;

  beforeEach(async () => {
    requests = [];
    chunks = [];
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => {
        raw += part;
      });
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await getModelRuntime().setRuntimeApiKey("edenai", "eden-billing-key");
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getModelRuntime().removeRuntimeApiKey("edenai");
  });

  /** Resolve `edenai/<id>` exactly as a run does, then point it at the stub. */
  function resolveAtStub(id: string): Model<Api> {
    const model = resolveModel(`edenai/${id}`, getModelRegistry());
    return { ...model, baseUrl } as Model<Api>;
  }

  /** The SSE frames Eden sends for a turn that reports the given usage. */
  function turnWithUsage(
    id: string,
    usage: Record<string, unknown>,
    text = "done.",
  ): unknown[] {
    return [
      {
        id: "chatcmpl-bill-1",
        object: "chat.completion.chunk",
        created: 1_742_000_100,
        model: id,
        choices: [
          { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
      },
      // Eden's final usage-only chunk, the one stream_options.include_usage buys.
      {
        id: "chatcmpl-bill-1",
        object: "chat.completion.chunk",
        created: 1_742_000_100,
        model: id,
        choices: [],
        usage,
      },
    ];
  }

  /** Drain a stream and return its terminal assistant message. */
  async function runTurn(model: Model<Api>) {
    const stream = getModelRuntime().stream(model, {
      systemPrompt: "You are Kady.",
      messages: [{ role: "user", content: "count my tokens", timestamp: Date.now() }],
    } satisfies Context);
    let done: any;
    for await (const event of stream) {
      if (event.type === "done") done = event;
      if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
    }
    return done.message;
  }

  /**
   * Replay `api/sessions.ts`'s ledger step for one turn, using its real
   * functions: the turn_end tally, the getSessionStats delta, the field-wise
   * max of the two, and recordRun with the run's BillingContext.
   */
  async function ledgerTurn(args: {
    projectId: string;
    sessionId: string;
    model: Model<Api>;
    usage: Parameters<typeof addTurnUsage>[1];
  }) {
    const billing = await billingForModel(args.model, {
      checkAuth: async () => ({ type: "api_key" as const, source: "EDENAI_API_KEY" }),
    } as never);

    // sessions.ts: `addTurnUsage(turnTally, usage)` on every turn_end event.
    const turnTally = emptySnapshot();
    addTurnUsage(turnTally, args.usage);

    // sessions.ts: `snapshot(session)` before/after prompt(), which reads
    // getSessionStats(). Pi's stats sum the same per-turn usage (see
    // pi-coding-agent core/usage-totals.ts addUsageToTotals), so a
    // single-turn run's cumulative stats equal this turn's usage.
    const u = args.usage;
    const statsAfter = {
      costUsd: u.cost?.total ?? 0,
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      total: (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    };

    const run = snapshotMax(snapshotDelta(emptySnapshot(), statsAfter), turnTally);
    return {
      billing,
      run,
      entry: recordRun({
        sessionId: args.sessionId,
        projectId: args.projectId,
        model: modelReference(args.model),
        before: emptySnapshot(),
        after: run,
        billing,
      }),
    };
  }

  it("prices a streamed turn from Eden per-token pricing and ledgers $0.0035", async () => {
    // 1. Eden /v3/models -> pricing (NOT list_pricing) -> per-1M catalogue.
    const catalogue = parseEdenaiModels({
      data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M, output: OUT_PER_M })],
    });
    expect(catalogue[0].costInput).toBeCloseTo(IN_PER_M, 12);
    expect(catalogue[0].costOutput).toBeCloseTo(OUT_PER_M, 12);
    setEdenaiCatalogueForTests(catalogue);

    // 2. -> Pi Model.cost, in Pi's USD-per-1M representation.
    const model = resolveAtStub(GPT_4O_MINI);
    expect(model.cost).toMatchObject({ input: IN_PER_M, output: OUT_PER_M });

    // 3. -> a real streamed turn, priced by pi-ai's calculateCost.
    chunks = turnWithUsage(GPT_4O_MINI, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });
    const message = await runTurn(model);

    expect(message.usage.input).toBe(INPUT_TOKENS);
    expect(message.usage.output).toBe(OUTPUT_TOKENS);
    expect(message.usage.cost.input).toBeCloseTo(0.0005, 12);
    expect(message.usage.cost.output).toBeCloseTo(0.003, 12);
    expect(message.usage.cost.total).toBeCloseTo(EXPECTED_USD, 12);

    // 4. -> billing/ledger.
    createProject({ name: "Eden e2e", projectId: "edenai-e2e", spendLimitUsd: 1 });
    const { billing, entry } = await ledgerTurn({
      projectId: "edenai-e2e",
      sessionId: "e2e",
      model,
      usage: message.usage,
    });

    expect(billing.billingMode).toBe("payg");
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe(`edenai/${GPT_4O_MINI}`);
    expect(entry!.provider).toBe("edenai");
    expect(entry!.promptTokens).toBe(INPUT_TOKENS);
    expect(entry!.completionTokens).toBe(OUTPUT_TOKENS);
    expect(entry!.totalTokens).toBe(INPUT_TOKENS + OUTPUT_TOKENS);
    // The number the spend cap reads, not a helper's return value.
    expect(entry!.costUsd).toBeCloseTo(EXPECTED_USD, 12);
    // payg is cap-counted, so nothing is moved into listPriceUsd.
    expect(entry!.listPriceUsd).toBeUndefined();

    // 5. -> final usage cost, read back off disk.
    const session = sessionCostSummary("e2e", "edenai-e2e");
    expect(session.totalUsd).toBeCloseTo(EXPECTED_USD, 12);
    expect(session.agentUsd).toBeCloseTo(EXPECTED_USD, 12);
    expect(session.subscriptionTokens).toBe(0);
    expect(projectCostSummary("edenai-e2e").committedUsd).toBeCloseTo(EXPECTED_USD, 12);
  });

  // Kady's Eden path is always wire-streaming (pi-ai's openai-completions
  // adapter sets stream: true unconditionally), but `complete()` is the
  // non-streaming *call* surface used by subagents and helper routes. It must
  // price identically, or the same tokens would cost different amounts
  // depending on which entry point ran them.
  it("prices the non-streaming complete() call identically", async () => {
    setEdenaiCatalogueForTests(
      parseEdenaiModels({
        data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M, output: OUT_PER_M })],
      }),
    );
    const model = resolveAtStub(GPT_4O_MINI);
    chunks = turnWithUsage(GPT_4O_MINI, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });

    const message = await getModelRuntime().complete(model, {
      systemPrompt: "You are Kady.",
      messages: [{ role: "user", content: "count my tokens", timestamp: Date.now() }],
    } satisfies Context);

    expect(message.usage.input).toBe(INPUT_TOKENS);
    expect(message.usage.output).toBe(OUTPUT_TOKENS);
    expect(message.usage.cost.total).toBeCloseTo(EXPECTED_USD, 12);

    createProject({ name: "Eden sync", projectId: "edenai-sync", spendLimitUsd: 1 });
    const { entry } = await ledgerTurn({
      projectId: "edenai-sync",
      sessionId: "sync",
      model,
      usage: message.usage,
    });
    expect(entry!.costUsd).toBeCloseTo(EXPECTED_USD, 12);
  });

  // A turn whose usage chunk never arrives must not be silently ledgered as
  // free tokens: with no usage there is nothing to record at all.
  it("records nothing when Eden sends no usage chunk", async () => {
    setEdenaiCatalogueForTests(
      parseEdenaiModels({
        data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M, output: OUT_PER_M })],
      }),
    );
    const model = resolveAtStub(GPT_4O_MINI);
    chunks = [
      {
        id: "chatcmpl-bill-2",
        object: "chat.completion.chunk",
        created: 1_742_000_101,
        model: GPT_4O_MINI,
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      },
    ];

    const message = await runTurn(model);
    expect(message.usage.input).toBe(0);
    expect(message.usage.output).toBe(0);

    // include_usage is what makes the usage chunk arrive; assert Kady asks for it.
    expect(requests[0].body.stream_options).toEqual({ include_usage: true });

    createProject({ name: "Eden nousage", projectId: "edenai-nousage", spendLimitUsd: 1 });
    const { entry } = await ledgerTurn({
      projectId: "edenai-nousage",
      sessionId: "nousage",
      model,
      usage: message.usage,
    });
    expect(entry).toBeNull();
    expect(projectCostSummary("edenai-nousage").committedUsd).toBe(0);
  });

  // Eden publishes cache_read_input_token_cost alongside the plain token costs.
  // It must be priced on its own axis: the cached tokens come *out* of the
  // billable input count, and the input/output rates stay untouched.
  it("keeps cache pricing on its own axis, leaving input/output pricing intact", async () => {
    const CACHE_PER_M = 0.05;
    const catalogue = parseEdenaiModels({
      data: [
        pricedRow(GPT_4O_MINI, {
          input: IN_PER_M,
          output: OUT_PER_M,
          cacheRead: CACHE_PER_M,
        }),
      ],
    });
    expect(catalogue[0]).toMatchObject({
      costInput: IN_PER_M,
      costOutput: OUT_PER_M,
      cacheRead: CACHE_PER_M,
      cacheWrite: 0,
    });
    setEdenaiCatalogueForTests(catalogue);

    const model = resolveAtStub(GPT_4O_MINI);
    expect(model.cost).toEqual({
      input: IN_PER_M,
      output: OUT_PER_M,
      cacheRead: CACHE_PER_M,
      cacheWrite: 0,
    });

    chunks = turnWithUsage(GPT_4O_MINI, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
      prompt_tokens_details: { cached_tokens: 400 },
    });
    const message = await runTurn(model);

    // 1000 prompt tokens = 600 fresh + 400 cache hits.
    expect(message.usage.input).toBe(600);
    expect(message.usage.cacheRead).toBe(400);
    expect(message.usage.output).toBe(OUTPUT_TOKENS);
    expect(message.usage.cost.input).toBeCloseTo(0.0003, 12); // 600 at $0.50/1M
    expect(message.usage.cost.cacheRead).toBeCloseTo(0.00002, 12); // 400 at $0.05/1M
    expect(message.usage.cost.output).toBeCloseTo(0.003, 12); // unchanged
    expect(message.usage.cost.cacheWrite).toBe(0);
    expect(message.usage.cost.total).toBeCloseTo(0.00332, 12);

    createProject({ name: "Eden cache", projectId: "edenai-cache", spendLimitUsd: 1 });
    const { entry } = await ledgerTurn({
      projectId: "edenai-cache",
      sessionId: "cache",
      model,
      usage: message.usage,
    });
    expect(entry!.promptTokens).toBe(600);
    expect(entry!.cachedTokens).toBe(400);
    expect(entry!.completionTokens).toBe(OUTPUT_TOKENS);
    expect(entry!.totalTokens).toBe(3_000);
    expect(entry!.costUsd).toBeCloseTo(0.00332, 12);
  });

  // The full Eden id must survive the ref round-trip on every axis that
  // matters: the wire request, the pricing lookup, and the ledger row.
  it("keeps a multi-slash Eden id intact through pricing, the wire, and the ledger", async () => {
    setEdenaiCatalogueForTests(
      parseEdenaiModels({
        data: [
          // A decoy priced 100x, under the id a splitting resolver would land on.
          pricedRow("fireworks_ai", { input: 50, output: 150 }),
          pricedRow(DEEP_ID, { input: IN_PER_M, output: OUT_PER_M }),
        ],
      }),
    );

    const model = resolveAtStub(DEEP_ID);
    expect(model.id).toBe(DEEP_ID);
    expect(modelReference(model)).toBe(`edenai/${DEEP_ID}`);
    // Priced from the full id, not the first segment's decoy.
    expect(model.cost).toMatchObject({ input: IN_PER_M, output: OUT_PER_M });

    chunks = turnWithUsage(DEEP_ID, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });
    const message = await runTurn(model);

    // The gateway is asked for the whole id.
    expect(requests[0].body.model).toBe(DEEP_ID);
    expect(message.usage.cost.total).toBeCloseTo(EXPECTED_USD, 12);

    createProject({ name: "Eden deep", projectId: "edenai-deep", spendLimitUsd: 1 });
    const { entry } = await ledgerTurn({
      projectId: "edenai-deep",
      sessionId: "deep",
      model,
      usage: message.usage,
    });
    expect(entry!.model).toBe(`edenai/${DEEP_ID}`);
    expect(entry!.costUsd).toBeCloseTo(EXPECTED_USD, 12);
    expect(entry!.billingMode).toBe("payg");
  });

  // The generic PAYG cap path, exercised with Eden rows only - no Eden-specific
  // cap logic exists and none should.
  it("counts Eden spend against the generic PAYG cap, below it and past it", async () => {
    setEdenaiCatalogueForTests(
      parseEdenaiModels({
        data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M, output: OUT_PER_M })],
      }),
    );
    const model = resolveAtStub(GPT_4O_MINI);
    // Two identical turns cost $0.0070; the cap sits between one and two.
    createProject({ name: "Eden cap", projectId: "edenai-cap", spendLimitUsd: 0.005 });

    chunks = turnWithUsage(GPT_4O_MINI, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });
    const first = await runTurn(model);
    const { billing } = await ledgerTurn({
      projectId: "edenai-cap",
      sessionId: "cap",
      model,
      usage: first.usage,
    });

    // 1. Below the cap: cap-counted, accrued, still admitted.
    expect(billingCountsTowardBudget(billing)).toBe(true);
    const under = isBudgetExceeded("edenai-cap");
    expect(under.totalUsd).toBeCloseTo(EXPECTED_USD, 12);
    expect(under.exceeded).toBe(false);

    // 3. Not free: Eden's spend is kept as costUsd, unlike NVIDIA's
    // provider-credit usage which normalizeUsageCost moves to listPriceUsd.
    expect(normalizeUsageCost(EXPECTED_USD, billing)).toEqual({ costUsd: EXPECTED_USD });
    expect(normalizeUsageCost(EXPECTED_USD, billingForProvider("nvidia", "api_key"))).toEqual({
      costUsd: 0,
      listPriceUsd: EXPECTED_USD,
    });

    // 2. A second identical turn crosses the cap, and the existing generic
    // guard (`billingCountsTowardBudget(runBilling) && budget.exceeded` in
    // api/sessions.ts) now refuses the next run.
    const second = await runTurn(model);
    await ledgerTurn({
      projectId: "edenai-cap",
      sessionId: "cap",
      model,
      usage: second.usage,
    });
    const over = isBudgetExceeded("edenai-cap");
    expect(over.totalUsd).toBeCloseTo(EXPECTED_USD * 2, 12);
    expect(over.limitUsd).toBe(0.005);
    expect(over.exceeded).toBe(true);
  });

  // Eden pricing is discovered, not checked in, so the ledger must follow a
  // refresh rather than a first-seen snapshot.
  it("ledgers at the refreshed price after Eden pricing changes", async () => {
    vi.stubEnv("EDENAI_API_KEY", "eden-billing-key");
    invalidateEdenaiCatalogue();
    setEdenaiCatalogueForTests(null);
    createProject({ name: "Eden refresh", projectId: "edenai-refresh", spendLimitUsd: 1 });

    // First discovery of a model Kady has never seen.
    const firstFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M, output: OUT_PER_M })],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", firstFetch);
    await edenaiCatalogue();
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(resolveModel(`edenai/${GPT_4O_MINI}`, getModelRegistry()).cost.input).toBeCloseTo(
      IN_PER_M,
      12,
    );

    // Eden doubles the price; a forced refresh must be what the ledger uses.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [pricedRow(GPT_4O_MINI, { input: IN_PER_M * 2, output: OUT_PER_M * 2 })],
            }),
            { status: 200 },
          ),
      ),
    );
    await edenaiCatalogue(true);

    // The stub gateway needs the real global fetch back to serve the turn.
    vi.unstubAllGlobals();

    const repriced = resolveAtStub(GPT_4O_MINI);
    expect(repriced.cost).toMatchObject({ input: IN_PER_M * 2, output: OUT_PER_M * 2 });

    chunks = turnWithUsage(GPT_4O_MINI, {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });
    const after = await runTurn(repriced);
    expect(after.usage.cost.total).toBeCloseTo(EXPECTED_USD * 2, 12);

    const { entry } = await ledgerTurn({
      projectId: "edenai-refresh",
      sessionId: "refresh",
      model: repriced,
      usage: after.usage,
    });
    expect(entry!.costUsd).toBeCloseTo(EXPECTED_USD * 2, 12);
  });

  /**
   * The one gap in the chain, asserted rather than hidden.
   *
   * `resolveModel` is synchronous and Eden's catalogue is the only source of
   * its pricing, so a ref to a model that discovery has never returned - a
   * hand-typed id, a stale persisted ref, a cold process whose warm-up failed
   * - resolves at $0. The run still executes and its TOKENS are ledgered as
   * payg, but its DOLLARS are $0, so it accrues nothing against the cap.
   *
   * `buildEdenaiModel` warns on exactly this path, and `models.ts` warms the
   * catalogue at startup to keep it rare, but there is no mechanism that makes
   * such a run's cost recoverable after the fact.
   */
  it("ledgers an undiscovered Eden model tokens at $0 - the known gap", async () => {
    setEdenaiCatalogueForTests([]); // discovery ran and does not know this id
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = resolveAtStub("vendor/never-discovered");
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spend limit"));
    warn.mockRestore();

    chunks = turnWithUsage("vendor/never-discovered", {
      prompt_tokens: INPUT_TOKENS,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
    });
    const message = await runTurn(model);

    // Tokens are real and recorded; the price is not known, so cost is $0.
    expect(message.usage.input).toBe(INPUT_TOKENS);
    expect(message.usage.output).toBe(OUTPUT_TOKENS);
    expect(message.usage.cost.total).toBe(0);

    createProject({ name: "Eden unknown", projectId: "edenai-unknown", spendLimitUsd: 0.001 });
    const { entry } = await ledgerTurn({
      projectId: "edenai-unknown",
      sessionId: "unknown",
      model,
      usage: message.usage,
    });

    // The row exists (tokens are non-zero) and is classified payg, so the
    // usage is visible - it just carries no dollars.
    expect(entry).not.toBeNull();
    expect(entry!.billingMode).toBe("payg");
    expect(entry!.totalTokens).toBe(3_000);
    expect(entry!.costUsd).toBe(0);
    expect(isBudgetExceeded("edenai-unknown").exceeded).toBe(false);
  });
});
