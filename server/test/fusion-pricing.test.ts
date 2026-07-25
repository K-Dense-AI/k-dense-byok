import { describe, expect, it } from "vitest";
import { buildFusionModel, catalogueEntryFor } from "../src/agent/models.ts";
import {
  DEFAULT_FUSION_CONFIGS,
  JUDGE_CALLS_PER_TURN,
  fusionJudgeModel,
  fusionPanelModels,
} from "../../web/src/lib/fusion-presets.ts";

// A fusion turn is "N panel calls + 1 judge call in addition to your normal
// request", and under the openrouter/fusion alias that fusion-bridge.ts always
// sends, the judge also writes the final answer — so the judge bills twice.
//   https://openrouter.ai/docs/guides/routing/routers/fusion-router
//   https://openrouter.ai/docs/guides/features/plugins/fusion
// Pricing the panel alone under-counted every fusion turn against the cap.

const PANEL_A = "anthropic/claude-opus-4.8";
const PANEL_B = "openai/gpt-5.5";

function config(panel: string[], judge?: string): Record<string, unknown> {
  return {
    model: "openrouter/fusion",
    plugins: [
      {
        id: "fusion",
        analysis_models: panel,
        ...(judge ? { model: judge } : {}),
      },
    ],
  };
}

describe("buildFusionModel judge pricing", () => {
  it("bills the judge twice on top of the panel", () => {
    const panelEntry = catalogueEntryFor(PANEL_B);
    const judgeEntry = catalogueEntryFor(PANEL_A);
    expect(panelEntry).toBeDefined();
    expect(judgeEntry).toBeDefined();

    const model = buildFusionModel(config([PANEL_B], PANEL_A));

    expect(model.cost.input).toBeCloseTo(
      panelEntry!.costInput + JUDGE_CALLS_PER_TURN * judgeEntry!.costInput,
    );
    expect(model.cost.output).toBeCloseTo(
      panelEntry!.costOutput + JUDGE_CALLS_PER_TURN * judgeEntry!.costOutput,
    );
  });

  // The regression this fixes: the judge is typically the priciest model in the
  // preset, so omitting it understated the turn by more than the panel itself.
  it("prices strictly higher than the panel alone", () => {
    const withJudge = buildFusionModel(config([PANEL_B], PANEL_A));
    const panelOnly = buildFusionModel(config([PANEL_B]));

    expect(withJudge.cost.input).toBeGreaterThan(panelOnly.cost.input);
    expect(withJudge.cost.output).toBeGreaterThan(panelOnly.cost.output);
  });

  // A judge that also sits in the panel is billed for both roles: once as a
  // panel member, twice as judge/fuser.
  it("counts a judge that is also a panel member in both roles", () => {
    const entry = catalogueEntryFor(PANEL_A)!;
    const model = buildFusionModel(config([PANEL_A], PANEL_A));

    expect(model.cost.input).toBeCloseTo((1 + JUDGE_CALLS_PER_TURN) * entry.costInput);
  });

  it("prices panel-only when the config names no judge", () => {
    const entry = catalogueEntryFor(PANEL_B)!;
    const model = buildFusionModel(config([PANEL_B]));

    expect(model.cost.input).toBeCloseTo(entry.costInput);
  });

  // Refusing here would break presets whose judge simply has no catalogue row;
  // it under-counts, and the picker flags the id instead.
  it("still prices a config whose judge is unknown to the catalogue", () => {
    const entry = catalogueEntryFor(PANEL_B)!;
    const model = buildFusionModel(config([PANEL_B], "nonexistent/judge-xyz"));

    expect(model.cost.input).toBeCloseTo(entry.costInput);
  });

  // Fails closed: a $0 fusion model would bypass the spend cap entirely.
  it("throws when nothing in the config is priceable", () => {
    expect(() => buildFusionModel(config(["nonexistent/panel-xyz"]))).toThrow(
      /no priceable models/i,
    );
    expect(() => buildFusionModel(config([]))).toThrow(/no priceable models/i);
  });

  // A priceable judge is enough on its own — the run is billable, so it should
  // not be refused just because the panel is unpriceable.
  it("runs when only the judge is priceable", () => {
    const judgeEntry = catalogueEntryFor(PANEL_A)!;
    const model = buildFusionModel(config(["nonexistent/panel-xyz"], PANEL_A));

    expect(model.cost.input).toBeCloseTo(JUDGE_CALLS_PER_TURN * judgeEntry.costInput);
  });
});

// The picker computes the same total from web/src/data/models.json, and the
// server ledgers from the catalogue. Separate copies of one formula: if they
// drift, users are quoted a price the ledger doesn't charge.
describe("picker/ledger pricing parity over the shipped presets", () => {
  it.each(DEFAULT_FUSION_CONFIGS.map((c) => [c.name, c] as const))(
    "%s",
    (_name, preset) => {
      const cfg = JSON.parse(preset.config) as Record<string, unknown>;

      // Recomputed the way use-models.ts does it, from the same catalogue.
      let prompt = 0;
      let completion = 0;
      for (const id of fusionPanelModels(cfg)) {
        const entry = catalogueEntryFor(id.replace(/^openrouter\//, ""));
        if (!entry) continue;
        prompt += entry.costInput;
        completion += entry.costOutput;
      }
      const judgeId = fusionJudgeModel(cfg);
      const judge = judgeId
        ? catalogueEntryFor(judgeId.replace(/^openrouter\//, ""))
        : undefined;
      if (judge) {
        prompt += JUDGE_CALLS_PER_TURN * judge.costInput;
        completion += JUDGE_CALLS_PER_TURN * judge.costOutput;
      }

      const model = buildFusionModel(cfg);
      expect(model.cost.input).toBeCloseTo(prompt);
      expect(model.cost.output).toBeCloseTo(completion);
      // Every shipped preset names a judge, and it must be priced.
      expect(judgeId).toBeTruthy();
      expect(judge).toBeDefined();
    },
  );
});
