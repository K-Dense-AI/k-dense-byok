import { describe, expect, it } from "vitest";
import { buildFusionRequestBody } from "../src/agent/fusion-bridge.ts";

// A representative chat/completions payload Pi assembles for a normal turn.
// model:"openrouter/anthropic/claude-opus-4.8" stands in for the resolved
// model's id (Pi defaults payload.model to model.id).
const basePayload = {
  model: "openrouter/anthropic/claude-opus-4.8",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
};

// The stored Fusion preset body (web/src/lib/fusion-presets.ts shape): top-level
// reasoning_effort/temperature plus a single "fusion" plugin (panel + judge).
const fusionConfig = {
  model: "openrouter/fusion",
  temperature: 0.6,
  reasoning_effort: "xhigh",
  plugins: [
    {
      id: "fusion",
      preset: "general-high",
      analysis_models: ["anthropic/claude-opus-4.8", "openai/gpt-5.5"],
      model: "anthropic/claude-opus-4.8",
      max_tool_calls: 8,
    },
  ],
};

describe("buildFusionRequestBody", () => {
  it("rewrites to a forced openrouter/fusion router call with reasoning+temperature inside the plugin", () => {
    const out = buildFusionRequestBody(basePayload, fusionConfig);

    // Router alias + forced fusion every message.
    expect(out.model).toBe("openrouter/fusion");
    expect(out.tool_choice).toBe("required");
    // Pi's agentic tools are dropped so the plugin injects + forces fusion.
    expect("tools" in out).toBe(false);
    // Panel/judge/limits + reasoning (xhigh passed through) + temperature live
    // INSIDE the plugin — the form OpenRouter's fusion router expects.
    expect(out.plugins).toEqual([
      {
        id: "fusion",
        preset: "general-high",
        analysis_models: ["anthropic/claude-opus-4.8", "openai/gpt-5.5"],
        model: "anthropic/claude-opus-4.8",
        max_tool_calls: 8,
        reasoning: { effort: "xhigh" },
        temperature: 0.6,
      },
    ]);
    // No conflicting top-level reasoning/temperature fields.
    expect("reasoning_effort" in out).toBe(false);
    expect("reasoning" in out).toBe(false);
    expect("temperature" in out).toBe(false);
    // Base payload preserved + not mutated.
    expect(out.messages).toBe(basePayload.messages);
    expect(out.stream).toBe(true);
    expect(basePayload.model).toBe("openrouter/anthropic/claude-opus-4.8");
    expect("plugins" in basePayload).toBe(false);
  });

  it("normalises effort inside the plugin and strips top-level reasoning + alias", () => {
    const withReasoning = { ...basePayload, reasoning: { effort: "low" }, reasoning_effort: "low" };
    const out = buildFusionRequestBody(withReasoning, { ...fusionConfig, reasoning_effort: "medium" });
    const plugin = (out.plugins as Array<Record<string, unknown>>)[0];
    expect(plugin.reasoning).toEqual({ effort: "medium" });
    expect("reasoning" in out).toBe(false);
    expect("reasoning_effort" in out).toBe(false);
  });

  it("omits temperature from the plugin when the preset has none", () => {
    const noTemp = { ...fusionConfig };
    delete (noTemp as { temperature?: number }).temperature;
    const out = buildFusionRequestBody(basePayload, noTemp);
    expect(out.model).toBe("openrouter/fusion");
    const plugin = (out.plugins as Array<Record<string, unknown>>)[0];
    expect("temperature" in plugin).toBe(false);
  });

  it("returns the base payload unchanged when there is no fusionConfig", () => {
    expect(buildFusionRequestBody(basePayload, null)).toBe(basePayload);
    expect(buildFusionRequestBody(basePayload, undefined)).toBe(basePayload);
  });

  it("returns the base payload unchanged when fusionConfig has no plugins", () => {
    const out = buildFusionRequestBody(basePayload, { reasoning_effort: "xhigh" });
    expect(out).toBe(basePayload);
  });
});
