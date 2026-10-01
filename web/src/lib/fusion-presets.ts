// OpenRouter Fusion presets.
//
// The stored `config` is the full Fusion request body, serialised as JSON (this
// is also what the editable textarea in Settings → Fusion shows/saves). The body
// follows the OpenRouter Fusion plugin docs
// (https://openrouter.ai/docs/guides/features/plugins/fusion): a `plugins` entry
// with id "fusion", a curated `preset`, the `analysis_models` panel (1-8 models),
// the judge `model`, and `max_tool_calls`. `reasoning_effort` (and optional
// `temperature`) are top-level request params.
//
// Models verified against https://openrouter.ai/api/v1/models on 2026-09-29.
// These are curated panels, not benchmarked combinations. Keep exact model ids
// so the picker and server can price every panel and judge consistently.

export interface StoredFusionConfig {
  id: string;
  name: string;
  /** Short provenance/benchmark note shown in the model-selector description. */
  note?: string;
  /** Full Fusion request body, serialised as JSON (what the editor shows/saves). */
  config: string;
}

// Bump when the built-in defaults below change so existing installs re-seed them.
// User-added configs are preserved during migration (see settings-dialog).
export const FUSION_DEFAULTS_VERSION = 5;

function fusionBody(b: {
  preset: string;
  analysis_models: string[];
  judge: string;
  reasoning_effort: string;
  max_tool_calls: number;
  temperature?: number;
}): string {
  const body: Record<string, unknown> = { model: "openrouter/fusion" };
  if (b.temperature !== undefined) body.temperature = b.temperature;
  body.reasoning_effort = b.reasoning_effort;
  body.plugins = [
    {
      id: "fusion",
      preset: b.preset,
      analysis_models: b.analysis_models,
      model: b.judge,
      max_tool_calls: b.max_tool_calls,
    },
  ];
  return JSON.stringify(body, null, 2);
}

// Opus 5.5 works on the panel but returned HTTP 400 as Fusion judge in live
// checks on 2026-09-29. Astra succeeded with the identical panel and settings.
const JUDGE = "openai/gpt-6-astra";

// Keep ids stable so saved selections continue to resolve after a model refresh.
export const DEFAULT_FUSION_CONFIGS: StoredFusionConfig[] = [
  {
    id: "fable5-gpt55",
    name: "Fable 5.1 + GPT-6 Astra",
    note: "Frontier pair; synthesized by GPT-6 Astra. Unbenchmarked combination.",
    config: fusionBody({ preset: "general-high", analysis_models: ["anthropic/claude-fable-5.1", "openai/gpt-6-astra"], judge: JUDGE, reasoning_effort: "xhigh", max_tool_calls: 16 }),
  },
  {
    id: "opus48-gpt55-gemini31pro",
    name: "Opus 5.5 + GPT-6 Astra + Gemini 3.1 Pro",
    note: "Three-provider research panel; synthesized by GPT-6 Astra. Unbenchmarked combination.",
    config: fusionBody({ preset: "general-high", analysis_models: ["anthropic/claude-opus-5.5", "openai/gpt-6-astra", "google/gemini-3.1-pro-preview"], judge: JUDGE, reasoning_effort: "high", max_tool_calls: 16 }),
  },
  {
    id: "opus48-gpt55",
    name: "Opus 5.5 + GPT-6.1 Sol",
    note: "General research and coding pair; synthesized by GPT-6 Astra. Unbenchmarked combination.",
    config: fusionBody({ preset: "general-high", analysis_models: ["anthropic/claude-opus-5.5", "openai/gpt-6.1-sol"], judge: JUDGE, reasoning_effort: "xhigh", max_tool_calls: 16 }),
  },
  {
    id: "opus48-opus48",
    name: "Opus 5.5 + Opus 5.5",
    note: "Two independent model calls with GPT-6 Astra synthesis; not independent evidence.",
    config: fusionBody({ preset: "general-high", analysis_models: ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5"], judge: JUDGE, reasoning_effort: "xhigh", max_tool_calls: 16 }),
  },
  {
    id: "exaflop",
    name: "Exaflop",
    note: "GPT-6 Astra Pro + Gemini 3.1 Pro + Fable 5.1; synthesized by GPT-6 Astra. Unbenchmarked combination.",
    config: fusionBody({ preset: "general-high", analysis_models: ["openai/gpt-6-astra-pro", "google/gemini-3.1-pro-preview", "anthropic/claude-fable-5.1"], judge: JUDGE, reasoning_effort: "high", max_tool_calls: 16 }),
  },
  {
    id: "budget-fusion",
    name: "Gemini 3.8 Flash + Kimi K3 + DeepSeek V4.1 Flash",
    note: "Lower-cost panel; synthesized by GPT-6 Astra. Unbenchmarked combination.",
    config: fusionBody({ preset: "general-budget", analysis_models: ["google/gemini-3.8-flash", "moonshotai/kimi-k3", "deepseek/deepseek-v4.1-flash"], judge: JUDGE, reasoning_effort: "high", max_tool_calls: 16 }),
  },
];

// Exact previous defaults let migration distinguish a shipped preset from a
// user's edited copy. Whitespace-only edits are still the same configuration.
const PREVIOUS_DEFAULTS = [
  ["fable5-gpt55", "Fable 5 + GPT-5.5", ["anthropic/claude-fable-5", "openai/gpt-5.5"]],
  ["opus48-gpt55-gemini31pro", "Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro", ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"]],
  ["opus48-gpt55", "Opus 4.8 + GPT-5.5", ["anthropic/claude-opus-4.8", "openai/gpt-5.5"]],
  ["opus48-opus48", "Opus 4.8 + Opus 4.8", ["anthropic/claude-opus-4.8", "anthropic/claude-opus-4.8"]],
  ["exaflop", "Exaflop", ["openai/gpt-5.5-pro", "google/gemini-3.1-pro-preview", "anthropic/claude-fable-5"]],
  ["budget-fusion", "Gemini 3.5 Flash + Kimi K2.6 + DeepSeek V4 Pro", ["google/gemini-3.5-flash", "moonshotai/kimi-k2.6", "deepseek/deepseek-v4-pro"]],
].map(([id, name, panel]) => ({
  id: id as string, name: name as string,
  config: fusionBody({ preset: id === "budget-fusion" ? "general-budget" : "general-high", analysis_models: panel as string[], judge: "anthropic/claude-opus-4.8", reasoning_effort: "xhigh", temperature: 1, max_tool_calls: 16 }),
}));

function samePreset(a: StoredFusionConfig, b: { name: string; config: string }): boolean {
  if (a.name !== b.name) return false;
  try { return JSON.stringify(JSON.parse(a.config)) === JSON.stringify(JSON.parse(b.config)); }
  catch { return a.config === b.config; }
}

/**
 * Panel (analysis) model ids for a parsed Fusion body. Reads the real-schema
 * `plugins[0].analysis_models`, falling back to the legacy `experts` array so
 * pre-v2 saved configs still price/display correctly.
 */
export function fusionPanelModels(cfg: Record<string, unknown>): string[] {
  const plugins = cfg.plugins as Array<Record<string, unknown>> | undefined;
  const fromPlugin = plugins?.[0]?.analysis_models;
  if (Array.isArray(fromPlugin)) return fromPlugin as string[];
  const legacy = cfg.experts;
  return Array.isArray(legacy) ? (legacy as string[]) : [];
}

/**
 * Judge model id for a parsed Fusion body (`plugins[0].model`).
 *
 * Under the `openrouter/fusion` alias this is billed twice per turn — see
 * JUDGE_CALLS_PER_TURN. Undefined means the request didn't name one, so
 * OpenRouter falls back to the first model of its Quality preset; we can't
 * resolve that server-side slug locally, so such a config prices panel-only.
 */
export function fusionJudgeModel(cfg: Record<string, unknown>): string | undefined {
  const plugins = cfg.plugins as Array<Record<string, unknown>> | undefined;
  const judge = plugins?.[0]?.model;
  return typeof judge === "string" && judge.trim() ? judge : undefined;
}

/**
 * How many times the judge model is billed on one fusion turn.
 *
 * OpenRouter runs "N panel calls + 1 judge call in addition to your normal
 * request" [1]. Kady always sends the `openrouter/fusion` alias (see
 * server/src/agent/fusion-bridge.ts), and under that alias the plugin's judge
 * "also becomes the model that writes your final answer" [2] — so the judge is
 * billed once for the structured analysis and once for the final answer, while
 * each panel model is billed once. Pricing the panel alone modelled a 3-model
 * preset at ~3x a solo completion where the docs say to expect ~4-5x, which
 * under-counted every fusion turn against the project spend cap.
 *
 * [1] https://openrouter.ai/docs/guides/routing/routers/fusion-router
 * [2] https://openrouter.ai/docs/guides/features/plugins/fusion
 */
export const JUDGE_CALLS_PER_TURN = 2;

// Ids of built-in presets that shipped in earlier versions and are retired now.
// They're dropped on migration so they don't linger as fake "user" configs.
const RETIRED_DEFAULT_IDS = new Set(["research-fusion", "frontier-council", "budget-trio"]);

/**
 * Refresh shipped presets while retaining user-added and user-edited configs.
 * An edited built-in gets a separate stable id so it can coexist with the new
 * default and is not overwritten on the next refresh.
 */
export function mergeWithDefaults(stored: StoredFusionConfig[]): StoredFusionConfig[] {
  const builtinIds = new Set(DEFAULT_FUSION_CONFIGS.map((d) => d.id));
  const usedIds = new Set([...builtinIds, ...stored.map((c) => c.id)]);
  const userConfigs: StoredFusionConfig[] = [];
  for (const config of stored) {
    if (RETIRED_DEFAULT_IDS.has(config.id)) continue;
    if (!builtinIds.has(config.id)) { userConfigs.push(config); continue; }
    const shipped = [...DEFAULT_FUSION_CONFIGS, ...PREVIOUS_DEFAULTS].filter((d) => d.id === config.id);
    if (shipped.some((d) => samePreset(config, d))) continue;
    let id = `custom-${config.id}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `custom-${config.id}-${suffix++}`;
    usedIds.add(id);
    userConfigs.push({ ...config, id });
  }
  return [...DEFAULT_FUSION_CONFIGS, ...userConfigs];
}

/**
 * Stored Fusion configs from localStorage, falling back to the built-in defaults
 * so presets appear in the model selector even before the user opens Settings.
 * When the stored defaults version is behind, the built-ins are refreshed
 * (read-only) so the selector reflects new presets immediately. Safe during SSR.
 */
export function loadFusionConfigs(): StoredFusionConfig[] {
  if (typeof window === "undefined") return DEFAULT_FUSION_CONFIGS;
  try {
    const raw = localStorage.getItem("fusionConfigs");
    if (!raw) return DEFAULT_FUSION_CONFIGS;
    const parsed = JSON.parse(raw) as StoredFusionConfig[];
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_FUSION_CONFIGS;
    const version = Number(localStorage.getItem("fusionConfigsVersion") || "0");
    return version < FUSION_DEFAULTS_VERSION ? mergeWithDefaults(parsed) : parsed;
  } catch {
    return DEFAULT_FUSION_CONFIGS;
  }
}
