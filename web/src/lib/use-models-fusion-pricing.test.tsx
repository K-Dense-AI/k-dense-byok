import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import staticModels from "@/data/models.json";
import type { Model } from "@/components/model-selector";
import {
  DEFAULT_FUSION_CONFIGS,
  JUDGE_CALLS_PER_TURN,
  fusionJudgeModel,
  fusionPanelModels,
} from "./fusion-presets";

// The picker's combined price has to match what buildFusionModel() ledgers on
// the server. It previously summed the analysis panel only, leaving the judge —
// which under the openrouter/fusion alias also writes the final answer, so bills
// twice — out of both the quote and the spend cap.

const CATALOGUE = staticModels as Model[];

function priceOf(modelId: string) {
  const clean = modelId.replace(/^openrouter\//, "");
  return CATALOGUE.find((m) => m.id === `openrouter/${clean}` || m.id === modelId)
    ?.pricing;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModels — fusion preset pricing", () => {
  it("prices every shipped preset as panel + 2× judge", async () => {
    vi.resetModules();
    const { useModels } = await import("./use-models");
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.models.some((m) => m.isFusion)).toBe(true),
    );

    for (const preset of DEFAULT_FUSION_CONFIGS) {
      const cfg = JSON.parse(preset.config) as Record<string, unknown>;
      let prompt = 0;
      let completion = 0;
      for (const id of fusionPanelModels(cfg)) {
        const pricing = priceOf(id);
        if (!pricing) continue;
        prompt += pricing.prompt;
        completion += pricing.completion;
      }
      const judgeId = fusionJudgeModel(cfg);
      const judge = judgeId ? priceOf(judgeId) : undefined;
      expect(judgeId, `${preset.name} names a judge`).toBeTruthy();
      expect(judge, `${preset.name} judge is priced`).toBeDefined();
      prompt += JUDGE_CALLS_PER_TURN * judge!.prompt;
      completion += JUDGE_CALLS_PER_TURN * judge!.completion;

      const model = result.current.models.find((m) => m.id === `fusion/${preset.id}`);
      expect(model, `${preset.name} is in the picker`).toBeDefined();
      expect(model!.pricing.prompt).toBeCloseTo(prompt);
      expect(model!.pricing.completion).toBeCloseTo(completion);
    }
  });

  it("names the judge and its multiplier in the description", async () => {
    vi.resetModules();
    const { useModels } = await import("./use-models");
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.models.some((m) => m.isFusion)).toBe(true),
    );

    const preset = DEFAULT_FUSION_CONFIGS[0];
    const cfg = JSON.parse(preset.config) as Record<string, unknown>;
    const model = result.current.models.find((m) => m.id === `fusion/${preset.id}`)!;

    expect(model.description).toContain(`judge ${fusionJudgeModel(cfg)}`);
    expect(model.description).toContain(`×${JUDGE_CALLS_PER_TURN}`);
    expect(model.description).toContain(`panel + ${JUDGE_CALLS_PER_TURN}× judge`);
  });

  // The judge dominates a cheap panel, which is exactly where the old
  // panel-only quote was most wrong.
  it("prices a budget panel well above its panel-only total", async () => {
    vi.resetModules();
    const { useModels } = await import("./use-models");
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.models.some((m) => m.isFusion)).toBe(true),
    );

    for (const preset of DEFAULT_FUSION_CONFIGS) {
      const cfg = JSON.parse(preset.config) as Record<string, unknown>;
      const panelOnly = fusionPanelModels(cfg).reduce(
        (sum, id) => sum + (priceOf(id)?.prompt ?? 0),
        0,
      );
      const model = result.current.models.find((m) => m.id === `fusion/${preset.id}`)!;
      expect(model.pricing.prompt).toBeGreaterThan(panelOnly);
    }
  });
});
