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
// The four multi-model panels below are the configurations OpenRouter reported
// as tested in "Fusion beats Frontier"
// (https://openrouter.ai/blog/announcements/fusion-beats-frontier/); Exaflop is
// our own panel. All are judged by Opus 4.8 at xhigh reasoning.

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
export const FUSION_DEFAULTS_VERSION = 3;

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

const JUDGE = "anthropic/claude-opus-4.8";

export const DEFAULT_FUSION_CONFIGS: StoredFusionConfig[] = [
  {
    id: "fable5-gpt55",
    name: "Fable 5 + GPT-5.5",
    note: "tested 69.0% DRACO — beats every individual model",
    config: fusionBody({
      preset: "general-high",
      analysis_models: ["anthropic/claude-fable-5", "openai/gpt-5.5"],
      judge: JUDGE,
      reasoning_effort: "xhigh",
      max_tool_calls: 8,
    }),
  },
  {
    id: "opus48-gpt55-gemini31pro",
    name: "Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro",
    note: "tested 68.3% on deep research tasks",
    config: fusionBody({
      preset: "general-high",
      analysis_models: [
        "anthropic/claude-opus-4.8",
        "openai/gpt-5.5",
        "google/gemini-3.1-pro-preview",
      ],
      judge: JUDGE,
      reasoning_effort: "xhigh",
      max_tool_calls: 8,
    }),
  },
  {
    id: "opus48-gpt55",
    name: "Opus 4.8 + GPT-5.5",
    note: "tested 67.6%",
    config: fusionBody({
      preset: "general-high",
      analysis_models: ["anthropic/claude-opus-4.8", "openai/gpt-5.5"],
      judge: JUDGE,
      reasoning_effort: "xhigh",
      max_tool_calls: 8,
    }),
  },
  {
    id: "exaflop",
    name: "Exaflop",
    note: "gpt-5.5-pro + gemini 3.1 pro + fable 5, synthesized by opus 4.8",
    config: fusionBody({
      preset: "general-high",
      analysis_models: [
        "openai/gpt-5.5-pro",
        "google/gemini-3.1-pro-preview",
        "anthropic/claude-fable-5",
      ],
      judge: JUDGE,
      reasoning_effort: "xhigh",
      temperature: 0.6,
      max_tool_calls: 8,
    }),
  },
  {
    id: "budget-fusion",
    name: "Gemini 3 Flash + Kimi K2.6 + DeepSeek V4 Pro",
    note: "tested 64.7% — budget panel, within 1% of Fable 5",
    config: fusionBody({
      preset: "general-budget",
      analysis_models: [
        "google/gemini-3-flash-preview",
        "moonshotai/kimi-k2.6",
        "deepseek/deepseek-v4-pro",
      ],
      judge: JUDGE,
      reasoning_effort: "xhigh",
      max_tool_calls: 4,
    }),
  },
];

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

// Ids of built-in presets that shipped in earlier versions and are retired now.
// They're dropped on migration so they don't linger as fake "user" configs.
const RETIRED_DEFAULT_IDS = new Set(["research-fusion", "frontier-council", "budget-trio"]);

/**
 * Refresh the built-in presets while preserving genuinely user-added configs.
 * User configs use random uuids, so they never collide with built-in/retired ids.
 */
export function mergeWithDefaults(stored: StoredFusionConfig[]): StoredFusionConfig[] {
  const builtinIds = new Set(DEFAULT_FUSION_CONFIGS.map((d) => d.id));
  const userConfigs = stored.filter(
    (c) => !builtinIds.has(c.id) && !RETIRED_DEFAULT_IDS.has(c.id),
  );
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
