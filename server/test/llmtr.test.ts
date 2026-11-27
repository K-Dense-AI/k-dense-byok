import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLMTR_BASE_URL,
  LLMTR_PROVIDER,
  buildLlmtrModel,
  fetchLlmtrCatalog,
  llmtrConfigured,
  mapLlmtrCatalog,
} from "../src/agent/llmtr.ts";
import { modelReference, resolveModel, ModelResolutionError } from "../src/agent/models.ts";
import { billingCountsTowardBudget, billingForProvider } from "../src/cost/billing.ts";

describe("LLMTR provider definition", () => {
  it("is a prepaid OpenAI-compatible gateway, not a Pi catalogue entry", () => {
    expect(LLMTR_PROVIDER).toMatchObject({
      id: "llmtr",
      name: "LLMTR",
      keyEnvVar: "LLMTR_API_KEY",
      billingMode: "subscription",
      synthesizeUnknownIds: true,
      oauth: false,
    });
    expect(LLMTR_PROVIDER.keysUrl).toBe("https://llmtr.com/dashboard/keys");
  });
});

describe("buildLlmtrModel / resolveModel", () => {
  const registry = { find: () => null } as never;

  it("builds a $0 Chat Completions model at https://llmtr.com/v1", () => {
    const model = buildLlmtrModel("qwen/qwen3.8-27b-free");
    expect(model.provider).toBe("llmtr");
    expect(model.id).toBe("qwen/qwen3.8-27b-free");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe(LLMTR_BASE_URL);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(modelReference(model)).toBe("llmtr/qwen/qwen3.8-27b-free");
  });

  it("keeps slashes inside the model id", () => {
    const model = resolveModel("llmtr/qwen/qwen3.8-27b-free", registry);
    expect(model.provider).toBe("llmtr");
    expect(model.id).toBe("qwen/qwen3.8-27b-free");
    expect(model.baseUrl).toBe(LLMTR_BASE_URL);
  });

  it("rejects a ref with no model id", () => {
    expect(() => resolveModel("llmtr/", registry)).toThrow(ModelResolutionError);
  });
});

describe("billing", () => {
  it("is a prepaid plan, so it never counts against the project spend cap", () => {
    const billing = billingForProvider("llmtr", "api_key");
    expect(billing).toEqual({
      provider: "llmtr",
      authType: "api_key",
      billingMode: "subscription",
    });
    expect(billingCountsTowardBudget(billing)).toBe(false);
  });
});

describe("mapLlmtrCatalog", () => {
  it("takes unique string ids and skips unusable rows", () => {
    const models = mapLlmtrCatalog({
      data: [
        { id: "qwen/qwen3.8-27b-free" },
        { id: "qwen/qwen3.8-27b-free" },
        { name: "no-id" },
        { id: "  " },
        { id: "deepseek/deepseek-v3.2" },
      ],
    });
    expect(models.map((model) => model.id)).toEqual([
      "qwen/qwen3.8-27b-free",
      "deepseek/deepseek-v3.2",
    ]);
  });

  it("returns an empty list for a malformed body", () => {
    expect(mapLlmtrCatalog(null)).toEqual([]);
    expect(mapLlmtrCatalog({ data: "nope" })).toEqual([]);
  });
});

describe("fetchLlmtrCatalog", () => {
  const saved = process.env.LLMTR_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.LLMTR_API_KEY;
    else process.env.LLMTR_API_KEY = saved;
  });

  it("does not fetch when no key is set", async () => {
    delete process.env.LLMTR_API_KEY;
    const fetchImpl = vi.fn();
    expect(llmtrConfigured()).toBe(false);
    expect(await fetchLlmtrCatalog(fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a successful catalogue response", async () => {
    process.env.LLMTR_API_KEY = "test-key-for-unit-tests-only";
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://llmtr.com/v1/models");
      return {
        ok: true,
        json: async () => ({ data: [{ id: "qwen/qwen3.8-27b-free" }] }),
      };
    });
    const models = await fetchLlmtrCatalog(fetchImpl as unknown as typeof fetch);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("qwen/qwen3.8-27b-free");
    expect(models[0].provider).toBe("llmtr");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns no models when the catalogue request fails", async () => {
    process.env.LLMTR_API_KEY = "test-key-for-unit-tests-only";
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await fetchLlmtrCatalog(fetchImpl as unknown as typeof fetch)).toEqual([]);
  });
});
