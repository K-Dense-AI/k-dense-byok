import { describe, expect, it } from "vitest";
import {
  firstFreeOpenRouterRef,
  isFreeOpenRouterRef,
  isModelAllowedForMode,
} from "../src/agent/models.ts";
import { collectSubagentModelRefs } from "../src/agent/subagent-bridge.ts";

describe("model access policy", () => {
  it("allows zero-priced OpenRouter and local models in free-local mode", () => {
    const firstFree = firstFreeOpenRouterRef();
    expect(firstFree).toMatch(/^openrouter\//);
    expect(isModelAllowedForMode(firstFree!, "free-local")).toBe(true);
    expect(isModelAllowedForMode("openrouter/example/model:free", "free-local")).toBe(true);
    expect(isModelAllowedForMode("ollama/qwen3.6", "free-local")).toBe(true);
  });

  it("rejects paid, unknown non-free, and Fusion refs in free-local mode", () => {
    expect(isModelAllowedForMode("openrouter/anthropic/claude-opus-4.8", "free-local")).toBe(false);
    expect(isModelAllowedForMode("openrouter/example/model", "free-local")).toBe(false);
    expect(isModelAllowedForMode("fusion/default", "free-local")).toBe(false);
  });

  it("treats local default providers as allowed", () => {
    expect(isModelAllowedForMode(undefined, "free-local", "ollama")).toBe(true);
  });

  it("handles Pi thinking suffixes on free OpenRouter refs", () => {
    expect(isFreeOpenRouterRef("openrouter/openai/gpt-oss-120b:free:high")).toBe(true);
    expect(isModelAllowedForMode("openrouter/openai/gpt-oss-120b:free:high", "free-local")).toBe(true);
  });

  it("collects explicit subagent model refs without scanning task prose", () => {
    const refs = collectSubagentModelRefs({
      agent: "reviewer",
      task: "Compare model organisms and model calibration text only.",
      model: "openrouter/openai/gpt-oss-20b:free",
      tasks: [
        { agent: "writer", modelCandidates: ["openrouter/anthropic/claude-opus-4.8"] },
        { agent: "critic", fallbackModels: ["ollama/qwen3.6"] },
      ],
    });
    expect(refs).toEqual([
      "openrouter/openai/gpt-oss-20b:free",
      "openrouter/anthropic/claude-opus-4.8",
      "ollama/qwen3.6",
    ]);
  });
});
