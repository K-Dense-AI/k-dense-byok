import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogueEntryFor, resolveModel, setupAuth } from "../src/agent/models.ts";

const registry = { find: vi.fn(() => undefined) };

afterEach(() => {
  delete process.env.ATLASCLOUD_API_KEY;
  vi.clearAllMocks();
});

// Reasoning-effort suffixes ("...-xhigh", "...-high", …) are an OpenRouter
// routing form, not separate catalogue rows. Before the fix they missed the
// catalogue and resolved to $0 cost — silently disabling the project spend cap
// (this is why the opus-4.8-xhigh default's spend wasn't capped).
describe("catalogueEntryFor (reasoning-effort suffix pricing)", () => {
  it("prices a reasoning-effort-suffixed id as its base model (not $0)", () => {
    const base = catalogueEntryFor("anthropic/claude-opus-4.8");
    const xhigh = catalogueEntryFor("anthropic/claude-opus-4.8-xhigh");
    expect(base).toBeDefined();
    expect(xhigh).toBeDefined();
    expect(xhigh!.costInput).toBe(base!.costInput);
    expect(xhigh!.costOutput).toBe(base!.costOutput);
    expect(xhigh!.costInput).toBeGreaterThan(0);
  });

  it("does NOT strip -fast (a distinct catalogue model with its own pricing)", () => {
    const fast = catalogueEntryFor("anthropic/claude-opus-4.8-fast");
    const base = catalogueEntryFor("anthropic/claude-opus-4.8");
    expect(fast).toBeDefined();
    expect(base).toBeDefined();
    // -fast is its own model (pricier); it must not collapse to the base price.
    expect(fast!.costInput).not.toBe(base!.costInput);
  });

  it("returns undefined for an unknown model", () => {
    expect(catalogueEntryFor("nonexistent/model-xyz")).toBeUndefined();
  });
});

describe("Atlas Cloud model resolution", () => {
  it("builds Atlas Cloud OpenAI-compatible models from atlascloud refs", () => {
    const model = resolveModel(
      "atlascloud/qwen/qwen3.5-flash",
      registry as never,
    );

    expect(model).toMatchObject({
      id: "qwen/qwen3.5-flash",
      name: "Qwen3.5 Flash",
      provider: "atlascloud",
      api: "openai-completions",
      baseUrl: "https://api.atlascloud.ai/v1",
      contextWindow: 1_000_000,
      maxTokens: 8192,
    });
    expect(model.cost.input).toBe(0.1);
    expect(model.cost.output).toBe(0.4);
    expect(registry.find).not.toHaveBeenCalledWith(
      "openrouter",
      "atlascloud/qwen/qwen3.5-flash",
    );
  });

  it("wires ATLASCLOUD_API_KEY into Pi auth storage", () => {
    process.env.ATLASCLOUD_API_KEY = "atlas-test-key";
    const authStorage = { setRuntimeApiKey: vi.fn() };

    setupAuth(authStorage as never);

    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith(
      "atlascloud",
      "atlas-test-key",
    );
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("ollama", "ollama");
  });
});
