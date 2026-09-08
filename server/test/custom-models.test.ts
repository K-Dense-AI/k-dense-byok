/**
 * Custom model servers: validation, managed-vs-foreign writes to models.json,
 * the routes (with an injected refresh), and ref resolution for custom ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

import {
  customModelForClient,
  customProviderIds,
  isCustomProvider,
  listCustomProviders,
  modelsJsonPath,
  validateCustomProviders,
  writeCustomProviders,
} from "../src/agent/custom-models.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";
import type { ProviderAuthRuntime } from "../src/agent/provider-auth.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-custom-models-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const vllm = {
  id: "hpc-vllm",
  name: "Lab vLLM",
  baseUrl: "http://gpu-node:8000/v1",
  api: "openai-completions",
  apiKey: "$LAB_KEY",
  models: [
    { id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ["text"], cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } },
    { id: "qwen/qwen3-32b" },
  ],
};

describe("validateCustomProviders", () => {
  it("accepts a well-formed provider and normalizes it", () => {
    const out = validateCustomProviders([vllm]);
    expect(typeof out).not.toBe("string");
    expect(out).toMatchObject([{ id: "hpc-vllm", api: "openai-completions", models: [{ id: "llama-3.3-70b", cost: { input: 0.5 } }, { id: "qwen/qwen3-32b" }] }]);
  });
  it("rejects collisions, bad ids, bad URLs, empty model lists and odd numbers", () => {
    expect(validateCustomProviders([{ ...vllm, id: "anthropic" }])).toMatch(/built-in/);
    expect(validateCustomProviders([{ ...vllm, id: "openrouter" }])).toMatch(/built-in/);
    expect(validateCustomProviders([{ ...vllm, id: "Bad Id" }])).toMatch(/invalid provider id/);
    expect(validateCustomProviders([{ ...vllm, baseUrl: "gpu-node:8000" }])).toMatch(/baseUrl/);
    expect(validateCustomProviders([{ ...vllm, api: "grpc" }])).toMatch(/api must be/);
    expect(validateCustomProviders([{ ...vllm, models: [] }])).toMatch(/at least one model/);
    expect(validateCustomProviders([{ ...vllm, models: [{ id: "a" }, { id: "a" }] }])).toMatch(/duplicate model/);
    expect(validateCustomProviders([{ ...vllm, models: [{ id: "a", cost: { input: -1 } }] }])).toMatch(/cost\.input/);
    expect(validateCustomProviders([vllm, vllm])).toMatch(/duplicate provider/);
    expect(validateCustomProviders("nope")).toMatch(/must be an array/);
  });
});

describe("writeCustomProviders", () => {
  it("writes Pi's models.json shape with a placeholder key for keyless servers and tracks managed ids", () => {
    const keyless = { ...vllm, id: "local-box", apiKey: "" };
    const listing = writeCustomProviders(validateCustomProviders([vllm, keyless]) as never, dir)!;
    expect(listing.map((p) => [p.id, p.managed])).toEqual([["hpc-vllm", true], ["local-box", true]]);
    const written = JSON.parse(fs.readFileSync(modelsJsonPath(dir), "utf-8"));
    expect(written.providers["hpc-vllm"]).toMatchObject({ name: "Lab vLLM", baseUrl: "http://gpu-node:8000/v1", api: "openai-completions", apiKey: "$LAB_KEY" });
    expect(written.providers["hpc-vllm"].models[0]).toEqual({
      id: "llama-3.3-70b",
      name: "Llama 3.3 70B",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    });
    expect(written.providers["local-box"].apiKey).toBe("none");
    expect(customProviderIds(dir)).toEqual(new Set(["hpc-vllm", "local-box"]));
    expect(isCustomProvider("hpc-vllm", dir)).toBe(true);

    // Removing one managed provider drops it from the file.
    writeCustomProviders(validateCustomProviders([vllm]) as never, dir);
    expect(Object.keys(JSON.parse(fs.readFileSync(modelsJsonPath(dir), "utf-8")).providers)).toEqual(["hpc-vllm"]);
    expect(customProviderIds(dir)).toEqual(new Set(["hpc-vllm"]));
  });

  it("keeps hand-written providers and other keys, and refuses to take one over", () => {
    fs.writeFileSync(
      modelsJsonPath(dir),
      JSON.stringify({ something: true, providers: { mine: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m" }] } } }),
    );
    expect(listCustomProviders(dir)).toEqual([expect.objectContaining({ id: "mine", managed: false })]);
    const listing = writeCustomProviders(validateCustomProviders([vllm]) as never, dir)!;
    expect(listing.map((p) => [p.id, p.managed])).toEqual([["mine", false], ["hpc-vllm", true]]);
    const written = JSON.parse(fs.readFileSync(modelsJsonPath(dir), "utf-8"));
    expect(written.something).toBe(true);
    expect(written.providers.mine.apiKey).toBe("k");
    expect(writeCustomProviders(validateCustomProviders([{ ...vllm, id: "mine" }]) as never, dir)).toBeNull();
    fs.writeFileSync(modelsJsonPath(dir), "{ nope");
    expect(writeCustomProviders([], dir)).toBeNull();
    expect(listCustomProviders(dir)).toEqual([]);
  });
});

describe("custom-model routes", () => {
  function runtime(): ProviderAuthRuntime {
    return {
      checkAuth: vi.fn(async (id: string) => (id === "hpc-vllm" ? { type: "api_key", source: "test" } : undefined)),
      login: vi.fn(),
      logout: vi.fn(),
      listCredentials: vi.fn(async () => []),
      getAvailable: vi.fn(async (id: string) =>
        id === "hpc-vllm"
          ? [{ id: "llama-3.3-70b", name: "Llama 3.3 70B", provider: "hpc-vllm", contextWindow: 128_000, maxTokens: 8_192, input: ["text"], reasoning: false, cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }]
          : [],
      ),
      getProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      isUsingOAuth: vi.fn(() => false),
    } as unknown as ProviderAuthRuntime;
  }

  it("saves, refreshes Pi, reports credential status and lists picker rows", async () => {
    const app = Fastify();
    const refreshModels = vi.fn(async () => {});
    const auth = runtime();
    await registerModelProviderRoutes(app, { runtime: auth, refreshModels, customModelsDir: dir });
    let res = await app.inject({ method: "PUT", url: "/custom-models", headers: { "content-type": "application/json" }, payload: { providers: [vllm] } });
    expect(res.statusCode).toBe(200);
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ providers: [{ id: "hpc-vllm", managed: true }], configured: { "hpc-vllm": true } });

    res = await app.inject({ method: "GET", url: "/custom-models" });
    expect(res.json().providers).toHaveLength(1);

    res = await app.inject({ method: "GET", url: "/providers/models" });
    const body = res.json() as { providers: { id: string; configured: boolean }[]; models: { id: string; sourceLabel: string; billingMode: string; pricing: { prompt: number } }[] };
    expect(body.providers).toContainEqual({ id: "hpc-vllm", configured: true });
    const row = body.models.find((m) => m.id === "hpc-vllm/llama-3.3-70b");
    expect(row).toMatchObject({ sourceLabel: "Custom servers", billingMode: "payg", pricing: { prompt: 0.5 } });

    res = await app.inject({ method: "PUT", url: "/custom-models", headers: { "content-type": "application/json" }, payload: { providers: [{ ...vllm, id: "anthropic" }] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("customModelForClient shapes the picker row", () => {
    const row = customModelForClient(
      { id: "m", name: "M", provider: "p", contextWindow: 1, maxTokens: 1, input: ["text", "image"], reasoning: true, cost: { input: 40, output: 50, cacheRead: 0, cacheWrite: 0 } } as never,
      { id: "p", name: "P", baseUrl: "http://x", api: "openai-completions", models: [], managed: true },
    );
    expect(row).toMatchObject({ id: "p/m", provider: "P", sourceId: "p", sourceLabel: "Custom servers", tier: "flagship", modality: "text+image->text", billingMode: "payg" });
  });
});
