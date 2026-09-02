import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  buildOpenAICompatibleModel,
  modelReference,
  resolveModel,
  ModelResolutionError,
  assertModelAuthentication,
  setupModelRuntime,
} from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";
import {
  billingCountsTowardBudget,
  billingForModel,
  billingForProvider,
} from "../src/cost/billing.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { emptySnapshot, recordRun, sessionCostSummary } from "../src/cost/ledger.ts";
import {
  makeSubagentLedgerExtension,
  pinInheritedChildModels,
} from "../src/agent/subagent-bridge.ts";

// OpenAI-compatible endpoints discovered through the standard /v1/models endpoint.
// No-key endpoints retain local/free semantics; authenticated generic proxies are
// marked externally billed because their real pricing is not reliably discoverable.

describe("buildOpenAICompatibleModel", () => {
  it("builds a $0, non-reasoning model against the configured base URL", () => {
    const model = buildOpenAICompatibleModel("qwen3-8b");

    expect(model.provider).toBe("openai-compatible");
    expect(model.id).toBe("qwen3-8b");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toMatch(/\/v1$/);
    expect(model.reasoning).toBe(false);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("round-trips through modelReference", () => {
    const model = buildOpenAICompatibleModel("qwen3-8b");
    expect(modelReference(model)).toBe("openai-compatible/qwen3-8b");
  });
});

describe("setupModelRuntime (openai-compatible auth)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("registers the configured endpoint key with the OpenAI-compatible provider", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "proxy-secret");
    const registerProvider = vi.fn();
    const runtime = { registerProvider, setRuntimeApiKey: vi.fn() };

    await setupModelRuntime(runtime as never);

    expect(registerProvider).toHaveBeenCalledWith(
      "openai-compatible",
      expect.objectContaining({ apiKey: "proxy-secret", api: "openai-completions" }),
    );
  });
});

describe("resolveModel (openai-compatible refs)", () => {
  it("resolves a bare model id", () => {
    const model = resolveModel("openai-compatible/qwen3-8b", getModelRegistry());
    expect(model.provider).toBe("openai-compatible");
    expect(model.id).toBe("qwen3-8b");
  });

  // LM Studio ids routinely contain a slash ("qwen/qwen3-8b"), so only the
  // provider prefix may be stripped — splitting on every "/" would truncate.
  it("keeps slashes inside the model id", () => {
    const model = resolveModel("openai-compatible/qwen/qwen3-8b", getModelRegistry());
    expect(model.id).toBe("qwen/qwen3-8b");
    expect(modelReference(model)).toBe("openai-compatible/qwen/qwen3-8b");
  });

  it("rejects a ref with no model id", () => {
    expect(() => resolveModel("openai-compatible/", getModelRegistry())).toThrow(
      ModelResolutionError,
    );
  });

  it("needs no provider auth (the credential is a placeholder)", async () => {
    const runtime = { checkAuth: vi.fn() };
    await expect(
      assertModelAuthentication(buildOpenAICompatibleModel("qwen3-8b"), runtime as never),
    ).resolves.toBeUndefined();
    expect(runtime.checkAuth).not.toHaveBeenCalled();
  });
});

describe("billing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is local without an endpoint key, so it never counts against the project spend cap", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    const billing = billingForProvider("openai-compatible");
    expect(billing).toEqual({
      provider: "openai-compatible",
      authType: "local",
      billingMode: "local",
    });
    expect(billingCountsTowardBudget(billing)).toBe(false);
  });


  it("marks authenticated generic endpoints as externally billed", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "proxy-secret");
    const billing = billingForProvider("openai-compatible");
    expect(billing).toEqual({
      provider: "openai-compatible",
      authType: "api_key",
      billingMode: "external",
    });
    expect(billingCountsTowardBudget(billing)).toBe(false);

    const runtime = { checkAuth: vi.fn() };
    const modelBilling = await billingForModel(
      buildOpenAICompatibleModel("proxy-model"),
      runtime as never,
    );
    expect(modelBilling.billingMode).toBe("external");
    expect(runtime.checkAuth).not.toHaveBeenCalled();
  });

  it("allows an authenticated local endpoint to opt back into local billing", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "local-secret");
    vi.stubEnv("OPENAI_COMPATIBLE_BILLING_MODE", "local");
    expect(billingForProvider("openai-compatible").billingMode).toBe("local");
  });

  it("classifies the local model without consulting provider auth", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    const runtime = { checkAuth: vi.fn() };
    const billing = await billingForModel(
      buildOpenAICompatibleModel("qwen3-8b"),
      runtime as never,
    );
    expect(billing.billingMode).toBe("local");
    expect(runtime.checkAuth).not.toHaveBeenCalled();
  });

  // Without the prefix rule in the ledger, an openai-compatible row falls
  // through to the payg default and is counted as billable spend.
  it("ledgers a run as local rather than payg", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    createProject({ name: "OAI compat", projectId: "oai-compat" });
    resolvePaths("oai-compat");
    const entry = recordRun({
      sessionId: "s1",
      projectId: "oai-compat",
      model: "openai-compatible/qwen3-8b",
      before: emptySnapshot(),
      after: { ...emptySnapshot(), input: 10, output: 5, total: 15 },
    });

    expect(entry).not.toBeNull();
    expect(entry!.billingMode).toBe("local");
    expect(entry!.provider).toBe("openai-compatible");
    expect(entry!.costUsd).toBe(0);
  });

  // Subagents resolve their own billing from the child's model ref, on a code
  // path separate from the ledger's — it needs the same prefix rule.
  it("ledgers a subagent run on a local model as local", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    createProject({ name: "OAI compat sub", projectId: "oai-compat-sub" });
    const handlers = new Map<string, (event: any) => any>();
    const extension = makeSubagentLedgerExtension(
      "oai-compat-sub",
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
                model: "openai-compatible/qwen3-8b",
                usage: { input: 30, output: 10, cost: 0 },
              },
            ],
          },
        ],
      },
    });

    const summary = sessionCostSummary("parent-session", "oai-compat-sub");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].billingMode).toBe("local");
    expect(summary.totalUsd).toBe(0);
  });
});

describe("GET /openai-compatible/models", () => {
  let server: http.Server;
  let baseUrl: string;
  /** Set by each test to control what the fake server returns. */
  let respond: (res: http.ServerResponse) => void;
  let requestedPaths: string[];
  let requestedAuthHeaders: Array<string | undefined>;

  beforeEach(async () => {
    requestedPaths = [];
    requestedAuthHeaders = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    };
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      requestedAuthHeaders.push(req.headers.authorization);
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * config.ts reads the environment once at import, so the route has to be
   * loaded fresh per test with the base URL already pointing at the fake server.
   */
  async function buildRoutes(
    envBaseUrl: string | undefined,
    apiKey = "",
    billingMode = "",
  ) {
    vi.resetModules();
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", envBaseUrl ?? "");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", apiKey);
    vi.stubEnv("OPENAI_COMPATIBLE_BILLING_MODE", billingMode);
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const app = Fastify();
    await registerSystemRoutes(app);
    return app;
  }

  it("maps /v1/models into the picker's model shape", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "qwen/qwen3-8b" }, { id: "llama-3.1-8b-instruct" }],
        }),
      );
    };
    const app = await buildRoutes(baseUrl);

    const response = await app.inject({ url: "/openai-compatible/models" });
    const body = response.json();

    expect(requestedPaths).toEqual(["/v1/models"]);
    expect(body.available).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.billingMode).toBe("local");
    expect(body.models).toEqual([
      {
        id: "openai-compatible/qwen/qwen3-8b",
        label: "qwen/qwen3-8b",
        provider: "OpenAI-Compatible",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local OpenAI-compatible model: qwen/qwen3-8b",
        billingMode: "local",
      },
      {
        id: "openai-compatible/llama-3.1-8b-instruct",
        label: "llama-3.1-8b-instruct",
        provider: "OpenAI-Compatible",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local OpenAI-compatible model: llama-3.1-8b-instruct",
        billingMode: "local",
      },
    ]);
    await app.close();
  });

  it("accepts a copied /v1 base URL without duplicating the path", async () => {
    const app = await buildRoutes(`${baseUrl}/v1`);

    await app.inject({ url: "/openai-compatible/models" });

    expect(requestedPaths).toEqual(["/v1/models"]);
    await app.close();
  });

  it("sends Bearer auth and marks proxy models externally billed", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }));
    };
    const app = await buildRoutes(baseUrl, "proxy-secret");

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(requestedAuthHeaders).toEqual(["Bearer proxy-secret"]);
    expect(body.billingMode).toBe("external");
    expect(body.models[0]).toMatchObject({
      id: "openai-compatible/openai/gpt-5",
      billingMode: "external",
      description: "OpenAI-compatible endpoint model: openai/gpt-5 (externally billed)",
    });
    await app.close();
  });

  // One odd row must not blank out the list: servers disagree on everything
  // except `id`, and some emit padding entries.
  it("skips malformed entries instead of failing discovery", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "good-model" },
            { name: "no-id-field" },
            { id: "" },
            { id: 42 },
            null,
            { id: "good-model" },
            { id: "second-model", owned_by: "someone" },
          ],
        }),
      );
    };
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "openai-compatible/good-model",
      "openai-compatible/second-model",
    ]);
    await app.close();
  });

  it("reports unavailable when the server is not running", async () => {
    // Nothing listens on port 1 — a connection refusal, not a timeout.
    const app = await buildRoutes("http://127.0.0.1:1");

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body).toEqual({ available: false, configured: true, billingMode: "local", models: [] });
    await app.close();
  });

  it("reports unavailable when the server answers with an error status", async () => {
    respond = (res) => {
      res.writeHead(500);
      res.end("nope");
    };
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body).toEqual({ available: false, configured: true, billingMode: "local", models: [] });
    await app.close();
  });

  // `configured: false` is what keeps the picker section hidden for the many
  // users who have never run one of these servers.
  it("reports configured:false when the base URL was never set", async () => {
    const app = await buildRoutes(undefined);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body.configured).toBe(false);
    await app.close();
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const app = await buildRoutes(`${baseUrl}/`);

    await app.inject({ url: "/openai-compatible/models" });

    expect(requestedPaths).toEqual(["/v1/models"]);
    await app.close();
  });
});
