import { describe, expect, it } from "vitest";
import {
  assertModelAuthentication,
  catalogueEntryFor,
  ModelAuthenticationError,
  ModelResolutionError,
  modelReference,
  resolveModel,
} from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";

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
    // -fast is its own (pricier) model, not a reasoning-effort suffix, so it
    // must never collapse to the base row. The Anthropic -fast variants have
    // been delisted from OpenRouter, so a correct lookup finds nothing; a
    // suffix-stripping one would wrongly return `base`. Tolerate a relisting
    // as long as the pricing stays distinct.
    const base = catalogueEntryFor("anthropic/claude-opus-5");
    expect(base).toBeDefined();
    const fast = catalogueEntryFor("anthropic/claude-opus-5-fast");
    expect(fast === undefined || fast.costInput !== base!.costInput).toBe(true);
  });

  it("returns undefined for an unknown model", () => {
    expect(catalogueEntryFor("nonexistent/model-xyz")).toBeUndefined();
  });
});

describe("provider-aware model resolution", () => {
  const registry = getModelRegistry();

  it.each([
    ["anthropic/claude-opus-4-8", "anthropic"],
    ["openai-codex/gpt-5.6-sol", "openai-codex"],
    ["github-copilot/claude-sonnet-5", "github-copilot"],
    ["xai/grok-4.5", "xai"],
  ])("resolves %s through its direct Pi provider", (ref, provider) => {
    const model = resolveModel(ref, registry);
    expect(model.provider).toBe(provider);
    expect(modelReference(model)).toBe(ref);
  });

  it("keeps canonical and legacy OpenRouter refs on OpenRouter", () => {
    expect(
      resolveModel("openrouter/anthropic/claude-opus-4.8", registry).provider,
    ).toBe("openrouter");
    expect(resolveModel("meta-llama/llama-3.3-70b-instruct", registry).provider).toBe(
      "openrouter",
    );
  });

  it("refuses unknown direct-provider models instead of synthesizing OpenRouter", () => {
    expect(() =>
      resolveModel("anthropic/not-a-real-subscription-model", registry),
    ).toThrowError(ModelResolutionError);
  });

  it("requires OAuth rather than an ambient API key for subscription providers", async () => {
    const model = resolveModel("anthropic/claude-opus-4-8", registry);
    const apiKeyRuntime = {
      checkAuth: async () => ({ type: "api_key" as const, source: "ANTHROPIC_API_KEY" }),
    };
    await expect(
      assertModelAuthentication(
        model,
        apiKeyRuntime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).rejects.toBeInstanceOf(ModelAuthenticationError);

    const oauthRuntime = {
      checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
    };
    await expect(
      assertModelAuthentication(
        model,
        oauthRuntime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).resolves.toBeUndefined();
  });
});
