import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIGS, FUSION_DEFAULTS_VERSION, loadFusionConfigs, mergeWithDefaults } from "./fusion-presets";

const previous = {
  id: "opus48-gpt55",
  name: "Opus 4.8 + GPT-5.5",
  config: JSON.stringify({ model: "openrouter/fusion", temperature: 1, reasoning_effort: "xhigh", plugins: [{ id: "fusion", preset: "general-high", analysis_models: ["anthropic/claude-opus-4.8", "openai/gpt-5.5"], model: "anthropic/claude-opus-4.8", max_tool_calls: 16 }] }),
};
afterEach(() => localStorage.clear());

describe("Fusion default migration", () => {
  it("replaces an unchanged old preset and preserves a user-added configuration", () => {
    const custom = { ...previous, id: "user-123", name: "My research panel" };
    const merged = mergeWithDefaults([previous, custom]);
    expect(merged).toEqual([...DEFAULT_FUSION_CONFIGS, custom]);
    expect(merged.find((c) => c.id === previous.id)?.name).toBe("Opus 5.5 + GPT-6.1 Sol");
  });

  it("keeps edited built-ins as custom copies without colliding with existing ids", () => {
    const edited = { ...previous, config: previous.config.replace('"max_tool_calls":16', '"max_tool_calls":3') };
    const custom = { ...previous, id: `custom-${previous.id}`, name: "Already custom" };
    const merged = mergeWithDefaults([edited, custom]);
    expect(merged).toContainEqual({ ...edited, id: `custom-${previous.id}-2` });
    expect(merged).toContainEqual(custom);
    expect(mergeWithDefaults(merged)).toEqual(merged);
  });

  it("retains a user's renamed preset", () => {
    const renamed = { ...previous, name: "My old panel" };
    expect(mergeWithDefaults([renamed])).toContainEqual({ ...renamed, id: `custom-${previous.id}` });
  });

  it("loads refreshed defaults before Settings opens without rewriting browser storage", () => {
    localStorage.setItem("fusionConfigs", JSON.stringify([previous]));
    localStorage.setItem("fusionConfigsVersion", "4");
    expect(loadFusionConfigs()).toEqual(DEFAULT_FUSION_CONFIGS);
    expect(localStorage.getItem("fusionConfigsVersion")).toBe("4");
    expect(FUSION_DEFAULTS_VERSION).toBe(5);
  });

  it("does not attach legacy benchmark scores to new combinations", () => {
    for (const preset of DEFAULT_FUSION_CONFIGS) {
      expect(preset.note).not.toMatch(/DRACO|\d+\.\d+%/);
      expect(JSON.parse(preset.config).plugins[0].model).toBe("openai/gpt-6-astra");
    }
  });
});
