import { describe, expect, it } from "vitest";
import { buildFusionRequestBody } from "../src/agent/fusion-bridge.ts";

// A representative chat/completions payload Pi would assemble for a normal turn.
// model:"openrouter/anthropic/claude-opus-4.8" stands in for the resolved
// model's id (Pi defaults payload.model to model.id), which must be overridden.
const basePayload = {
  model: "openrouter/anthropic/claude-opus-4.8",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
};

// The stored Fusion preset body (web/src/lib/fusion-presets.ts shape): a single
// "fusion" plugin with the analysis panel + judge, plus top-level reasoning_effort.
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
  it("rewrites the body for a Fusion request, merging plugins/reasoning/temperature", () => {
    const out = buildFusionRequestBody(basePayload, fusionConfig);

    // model is forced to openrouter/fusion (Pi would otherwise send the panel id).
    expect(out.model).toBe("openrouter/fusion");
    // Fusion-specific fields come from the preset.
    expect(out.plugins).toBe(fusionConfig.plugins);
    expect(out.reasoning_effort).toBe("xhigh");
    expect(out.temperature).toBe(0.6);
    // The rest of the base payload (messages, stream) is preserved.
    expect(out.messages).toBe(basePayload.messages);
    expect(out.stream).toBe(true);
    // Pure function: the input payload is not mutated.
    expect(basePayload.model).toBe("openrouter/anthropic/claude-opus-4.8");
    expect("plugins" in basePayload).toBe(false);
  });

  it("omits temperature when the preset has none", () => {
    const noTemp = { ...fusionConfig };
    delete (noTemp as { temperature?: number }).temperature;
    const out = buildFusionRequestBody(basePayload, noTemp);
    expect(out.model).toBe("openrouter/fusion");
    expect("temperature" in out).toBe(false);
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
