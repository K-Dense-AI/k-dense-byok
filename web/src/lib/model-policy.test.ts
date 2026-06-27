import { describe, expect, it } from "vitest";
import {
  filterAllowedModels,
  isAllowedModelForMode,
  isAllowedModelRefForMode,
} from "@/lib/model-policy";

const freeOpenRouter = {
  id: "openrouter/example/free",
  provider: "Example",
  pricing: { prompt: 0, completion: 0 },
};

const paidOpenRouter = {
  id: "openrouter/anthropic/claude-opus-4.8",
  provider: "Anthropic",
  pricing: { prompt: 15, completion: 75 },
};

const localOllama = {
  id: "ollama/qwen3.6",
  provider: "Ollama",
  pricing: { prompt: 0, completion: 0 },
};

const fusionModel = {
  id: "fusion/default",
  provider: "Openrouter Fusion",
  pricing: { prompt: 0, completion: 0 },
  isFusion: true,
};

const unknownRemote = {
  id: "remote/example",
  provider: "Remote",
  pricing: { prompt: 0, completion: 0 },
};

describe("model picker policy", () => {
  it("filters paid OpenRouter and Fusion models in free-local mode", () => {
    expect(isAllowedModelForMode(freeOpenRouter, "free-local")).toBe(true);
    expect(isAllowedModelForMode(localOllama, "free-local")).toBe(true);
    expect(isAllowedModelForMode(paidOpenRouter, "free-local")).toBe(false);
    expect(isAllowedModelForMode(fusionModel, "free-local")).toBe(false);
    expect(isAllowedModelForMode(unknownRemote, "free-local")).toBe(false);
    expect(filterAllowedModels([freeOpenRouter, paidOpenRouter, localOllama, fusionModel, unknownRemote], "free-local")).toEqual([
      freeOpenRouter,
      localOllama,
    ]);
  });

  it("checks stale selected model refs against the free catalogue", () => {
    expect(isAllowedModelRefForMode("ollama/qwen3.6", "free-local")).toBe(true);
    expect(isAllowedModelRefForMode("openrouter/openai/gpt-oss-120b:free", "free-local")).toBe(true);
    expect(isAllowedModelRefForMode("openrouter/anthropic/claude-opus-4.8", "free-local")).toBe(false);
    expect(isAllowedModelRefForMode("fusion/default", "free-local")).toBe(false);
  });
});
