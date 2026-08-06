/**
 * Model resolution for the Pi agent.
 *
 * Supported access paths:
 *   - OpenRouter (built-in Pi provider, key via OPENROUTER_API_KEY)
 *   - Pi OAuth providers (OpenAI Codex, Anthropic, GitHub Copilot, xAI)
 *   - NVIDIA NIM (built-in Pi provider, key via NVIDIA_API_KEY)
 *   - Ollama (local, OpenAI-compatible at OLLAMA_BASE_URL)
 *
 * The frontend picker sends model refs like "openrouter/anthropic/claude-opus-4.8"
 * or "ollama/llama3". OpenRouter has thousands of models that aren't all in Pi's
 * built-in table, so when `find()` misses we synthesize a Model from the
 * frontend catalogue (web/src/data/models.json) — Pi computes usage.cost from
 * `model.cost`, so we populate it from the catalogue's per-1M pricing.
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PROVIDER,
  OLLAMA_BASE_URL,
  OPENAI_COMPATIBLE_BASE_URL,
  REPO_ROOT,
} from "../config.ts";
import {
  isSubscriptionProvider,
  type SubscriptionProviderId,
} from "./provider-auth.ts";

// OpenRouter's base URL. Overridable via OPENROUTER_BASE_URL so the
// OpenAI-compatible provider can point at any compatible gateway — e.g.
// Requesty (https://router.requesty.ai/v1), which uses the same
// "vendor/model" ids and Bearer auth as OpenRouter.
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const CATALOGUE_PATH = path.join(REPO_ROOT, "web", "src", "data", "models.json");

interface CatalogueEntry {
  contextWindow: number;
  maxTokens: number;
  costInput: number; // USD per 1M prompt tokens
  costOutput: number; // USD per 1M completion tokens
  input: ("text" | "image")[];
  label: string;
}

let catalogue: Map<string, CatalogueEntry> | null = null;

/** Normalize a frontend/user model ref to a bare OpenRouter id ("vendor/model"). */
function stripOpenRouter(ref: string): string {
  return ref.startsWith("openrouter/") ? ref.slice("openrouter/".length) : ref;
}

function loadCatalogue(): Map<string, CatalogueEntry> {
  if (catalogue) return catalogue;
  const map = new Map<string, CatalogueEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf-8")) as unknown[];
    for (const item of raw) {
      const m = item as Record<string, unknown>;
      const id = String(m.id ?? "");
      if (!id) continue;
      const pricing = (m.pricing ?? {}) as Record<string, unknown>;
      const modality = String(m.modality ?? "text->text");
      const input: ("text" | "image")[] = modality.includes("image")
        ? ["text", "image"]
        : ["text"];
      map.set(stripOpenRouter(id), {
        contextWindow: Number(m.context_length ?? 0) || 128_000,
        maxTokens: Number(m.max_completion_tokens ?? 0) || 8192,
        costInput: Number(pricing.prompt ?? 0),
        costOutput: Number(pricing.completion ?? 0),
        input,
        label: String(m.label ?? id),
      });
    }
  } catch (err) {
    // Synthesized models fall back to $0 pricing, which silently disables the
    // project spend caps — make the misconfiguration visible.
    console.warn(
      `[models] Failed to load model catalogue at ${CATALOGUE_PATH}: ` +
        `${(err as Error).message}. Unknown models will be priced at $0, ` +
        `so spend limits will not accrue.`,
    );
  }
  catalogue = map;
  return map;
}

// OpenRouter reasoning-effort suffixes are a routing form (e.g.
// "anthropic/claude-opus-4.8-xhigh"), NOT separate catalogue rows — so an exact
// lookup misses and the model would resolve to $0 cost, silently disabling the
// project spend cap. These are stripped to price as the base model.
const EFFORT_SUFFIXES = ["-xhigh", "-high", "-medium", "-low", "-minimal", "-none"];

/**
 * Catalogue lookup tolerant of a reasoning-effort suffix: exact match first
 * (so "-fast", a distinct catalogue model with its own pricing, is never
 * stripped), then fall back to the base model with the effort suffix removed.
 */
export function catalogueEntryFor(orId: string): CatalogueEntry | undefined {
  const cat = loadCatalogue();
  const exact = cat.get(orId);
  if (exact) return exact;
  for (const sfx of EFFORT_SUFFIXES) {
    if (orId.endsWith(sfx)) {
      const base = cat.get(orId.slice(0, -sfx.length));
      if (base) return base;
    }
  }
  return undefined;
}

function buildOpenRouterModel(orId: string): Model<Api> {
  const cat = catalogueEntryFor(orId);
  return {
    id: orId,
    name: cat?.label ?? orId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: true,
    input: cat?.input ?? ["text"],
    cost: {
      input: cat?.costInput ?? 0,
      output: cat?.costOutput ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: cat?.contextWindow ?? 128_000,
    maxTokens: cat?.maxTokens ?? 8192,
  };
}

/** Panel (analysis) model ids out of a Fusion request body (real schema). */
function fusionPanelModels(fusionConfig: Record<string, unknown>): string[] {
  const plugins = fusionConfig.plugins as Array<Record<string, unknown>> | undefined;
  const panel = plugins?.[0]?.analysis_models;
  return Array.isArray(panel) ? (panel as string[]) : [];
}

/** Judge model id out of a Fusion request body (`plugins[0].model`). */
function fusionJudgeModel(fusionConfig: Record<string, unknown>): string | undefined {
  const plugins = fusionConfig.plugins as Array<Record<string, unknown>> | undefined;
  const judge = plugins?.[0]?.model;
  return typeof judge === "string" && judge.trim() ? judge : undefined;
}

/**
 * How many times the judge model is billed on one fusion turn.
 *
 * OpenRouter runs "N panel calls + 1 judge call in addition to your normal
 * request" [1]. fusion-bridge.ts always rewrites the body to the
 * `openrouter/fusion` alias, and under that alias the plugin's judge "also
 * becomes the model that writes your final answer" [2] — so the judge bills
 * once for the structured analysis and once for the final answer, while each
 * panel model bills once.
 *
 * Deliberately duplicated from web/src/lib/fusion-presets.ts (the frontend
 * can't import server code and vice versa). The picker's displayed price and
 * the ledgered price must agree; a parity test over the shipped presets guards
 * the two copies.
 *
 * [1] https://openrouter.ai/docs/guides/routing/routers/fusion-router
 * [2] https://openrouter.ai/docs/guides/features/plugins/fusion
 */
const JUDGE_CALLS_PER_TURN = 2;

/**
 * Build the Pi Model for an OpenRouter Fusion run. The id is "openrouter/fusion"
 * (the wire model the extension rewrites the body to), but its cost MUST be the
 * SUM of every model the turn bills — the analysis panel once each, plus the
 * judge JUDGE_CALLS_PER_TURN times. Otherwise Pi ledgers the turn short (cost
 * flows from model.cost, not the rewritten HTTP body) and the project spend cap
 * is eroded on every fusion message.
 *
 * Throws if the catalogue priced nothing at all, so the caller can abort rather
 * than proceed with a $0-priced (cap-bypassing) Fusion model. A config that is
 * only partly priceable still runs — it under-counts, but refusing would break
 * working presets whose judge or panel we simply have no catalogue row for. The
 * picker surfaces those ids in its "no catalogue price for" warning.
 */
export function buildFusionModel(fusionConfig: Record<string, unknown>): Model<Api> {
  let costInput = 0;
  let costOutput = 0;
  let priced = 0;
  for (const modelId of fusionPanelModels(fusionConfig)) {
    const entry = catalogueEntryFor(stripOpenRouter(modelId));
    if (!entry) continue;
    costInput += entry.costInput;
    costOutput += entry.costOutput;
    priced++;
  }
  const judgeId = fusionJudgeModel(fusionConfig);
  const judge = judgeId ? catalogueEntryFor(stripOpenRouter(judgeId)) : undefined;
  if (judge) {
    costInput += JUDGE_CALLS_PER_TURN * judge.costInput;
    costOutput += JUDGE_CALLS_PER_TURN * judge.costOutput;
    priced++;
  }
  if (priced === 0 || (costInput === 0 && costOutput === 0)) {
    throw new Error(
      "Fusion config has no priceable models in the catalogue; refusing to run a " +
        "$0-priced Fusion model (spend cap would be bypassed).",
    );
  }
  return {
    id: "openrouter/fusion",
    name: "OpenRouter Fusion",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: costInput, output: costOutput, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };
}

function buildOllamaModel(name: string): Model<Api> {
  return {
    id: name,
    name,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8192,
  };
}

/**
 * A model served by a local OpenAI-compatible server. Deliberately a parallel
 * path to buildOllamaModel rather than a shared base — the two only look alike
 * because both endpoints happen to be OpenAI-shaped.
 *
 * `/v1/models` carries no pricing or context length anywhere near reliably, so
 * this uses the same $0 / 32K defaults Ollama does. $0 is honest here only
 * because the provider is local-only; see `billingForProvider`.
 */
export function buildOpenAICompatibleModel(name: string): Model<Api> {
  return {
    id: name,
    name,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: `${OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, "")}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8192,
  };
}

/**
 * NVIDIA NIM (build.nvidia.com). A built-in Pi provider, so `registry.find`
 * normally supplies the model with real metadata; this fallback keeps refs to
 * models newer than Pi's catalogue snapshot runnable. $0 cost matches Pi's own
 * NIM entries — the endpoint draws NVIDIA API credits, not per-token USD (see
 * `billingForProvider`, which classifies the provider as external spend).
 */
export function buildNvidiaModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

/**
 * NIM model ids pinned via `NVIDIA_EXTRA_MODELS` (comma/whitespace separated).
 * Values are model ids exactly as sent to the API — no `nvidia/` ref prefix is
 * stripped, because NIM ids legitimately start with a vendor segment that can
 * itself be `nvidia/` (e.g. `nvidia/llama-3.3-nemotron-super-49b-v1.5`).
 * Lets private/early-access endpoints absent from Pi's catalogue (e.g.
 * `private/nvidia/...` ids) surface in the picker; the resolver already runs
 * any such ref via `buildNvidiaModel`.
 */
export function nvidiaExtraModelIds(): string[] {
  const raw = process.env.NVIDIA_EXTRA_MODELS ?? "";
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

/** Configure app-specific providers and runtime credentials. */
export async function setupModelRuntime(modelRuntime: ModelRuntime): Promise<void> {
  modelRuntime.registerProvider("ollama", {
    name: "Ollama",
    baseUrl: `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`,
    api: "openai-completions",
    apiKey: "ollama",
  });

  // Local servers ignore the credential, but Pi needs *something* to resolve
  // before it will dispatch — same placeholder arrangement as Ollama.
  modelRuntime.registerProvider("openai-compatible", {
    name: "OpenAI-Compatible",
    baseUrl: `${OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, "")}/v1`,
    api: "openai-completions",
    apiKey: "openai-compatible",
  });

  const orKey = process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY;
  if (orKey) await modelRuntime.setRuntimeApiKey("openrouter", orKey);
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export class ModelAuthenticationError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelAuthenticationError";
  }
}

/** Canonical provider/model ref used by the frontend, ledgers, and subagents. */
export function modelReference(model: Model<Api>): string {
  if (model.provider === "openrouter" && model.id === "openrouter/fusion") {
    return "openrouter/fusion";
  }
  return `${model.provider}/${model.id}`;
}

function configuredDefaultRef(): string {
  const provider = DEFAULT_MODEL_PROVIDER.trim().toLowerCase() || "openrouter";
  const id = DEFAULT_MODEL_ID.trim();
  if (!id) {
    throw new ModelResolutionError("DEFAULT_MODEL_ID is empty");
  }
  if (provider === "openrouter") {
    return id.startsWith("openrouter/") ? id : `openrouter/${id}`;
  }
  if (provider === "ollama") {
    return id.startsWith("ollama/") ? id : `ollama/${id}`;
  }
  if (isSubscriptionProvider(provider)) {
    return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
  }
  return `${provider}/${id}`;
}

function directProviderRef(
  ref: string,
): { providerId: SubscriptionProviderId; modelId: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const providerId = ref.slice(0, slash);
  if (!isSubscriptionProvider(providerId)) return null;
  return { providerId, modelId: ref.slice(slash + 1) };
}

export function isSubscriptionModelRef(ref: string): boolean {
  return directProviderRef(ref.trim()) !== null;
}

/**
 * Verify that a model's provider is configured for the intended product path.
 * Direct subscription providers deliberately require OAuth; ambient API keys
 * are not silently treated as subscription access.
 */
export async function assertModelAuthentication(
  model: Model<Api>,
  modelRuntime: ModelRuntime,
): Promise<void> {
  // Local servers authenticate with a placeholder credential, so there is no
  // real auth state to assert — reachability is the only failure mode.
  if (model.provider === "ollama" || model.provider === "openai-compatible") return;
  const auth = await modelRuntime.checkAuth(model.provider);
  if (!auth) {
    throw new ModelAuthenticationError(
      model.provider,
      model.provider === "openrouter"
        ? "OpenRouter is not configured. Add an API key in Settings or choose another model provider."
        : model.provider === "nvidia"
          ? "NVIDIA is not configured. Add an API key in Settings or choose another model provider."
          : `${model.provider} is not connected. Connect it in Settings or choose another model.`,
    );
  }
  if (isSubscriptionProvider(model.provider) && auth.type !== "oauth") {
    throw new ModelAuthenticationError(
      model.provider,
      `${model.provider} has an API key but no subscription login. Connect the subscription in Settings.`,
    );
  }
}

/**
 * Resolve a model ref to a Pi Model. Prefers Pi's built-in entry (so cost +
 * capabilities stay accurate), falling back to a synthesized model.
 */
export function resolveModel(
  ref: string | undefined,
  registry: ModelRegistry,
  fusionConfig?: Record<string, unknown>,
): Model<Api> {
  const usingDefault = !ref || !ref.trim();
  const r = usingDefault ? configuredDefaultRef() : ref.trim();
  // A "fusion/<id>" ref is the synthetic selector entry; resolve it to the real
  // openrouter/fusion Model, priced by the panel sum. The bare string ref can't
  // carry the panel prices, so the fusionConfig must be threaded in by the
  // caller (the /run handler). Throws if it wasn't — never proceed at $0.
  if (r.startsWith("fusion/")) {
    if (!fusionConfig) {
      throw new Error(
        `Fusion model ref "${r}" requires its fusionConfig to be passed for pricing.`,
      );
    }
    return buildFusionModel(fusionConfig);
  }
  if (r.startsWith("ollama/")) {
    return buildOllamaModel(r.slice("ollama/".length));
  }
  // Everything after the prefix is the model id verbatim — LM Studio ids often
  // contain slashes themselves (e.g. "qwen/qwen3-8b"), so this must not split.
  if (r.startsWith("openai-compatible/")) {
    const id = r.slice("openai-compatible/".length);
    if (!id) {
      throw new ModelResolutionError(`Model ref "${r}" is missing a model id`);
    }
    return buildOpenAICompatibleModel(id);
  }
  // NIM model ids contain slashes ("meta/llama-3.3-70b-instruct"), so like
  // openai-compatible everything after the prefix is the id verbatim.
  if (r.startsWith("nvidia/")) {
    const id = r.slice("nvidia/".length);
    if (!id) {
      throw new ModelResolutionError(`Model ref "${r}" is missing a model id`);
    }
    return registry.find("nvidia", id) ?? buildNvidiaModel(id);
  }
  const direct = directProviderRef(r);
  if (direct) {
    if (!direct.modelId) {
      throw new ModelResolutionError(`Model ref "${r}" is missing a model id`);
    }
    const model = registry.find(direct.providerId, direct.modelId);
    if (!model) {
      throw new ModelResolutionError(
        `Unknown ${direct.providerId} model "${direct.modelId}"`,
      );
    }
    return model;
  }
  if (r.startsWith("openrouter/")) {
    const orId = stripOpenRouter(r);
    if (!orId) throw new ModelResolutionError("OpenRouter model ref is missing a model id");
    return registry.find("openrouter", orId) ?? buildOpenRouterModel(orId);
  }
  // Backward compatibility for pre-canonical refs such as
  // "meta-llama/llama-3.3-70b": unknown prefixes remain OpenRouter vendor ids.
  const orId = stripOpenRouter(r);
  return registry.find("openrouter", orId) ?? buildOpenRouterModel(orId);
}

export function defaultModel(registry: ModelRegistry): Model<Api> {
  return resolveModel(undefined, registry);
}
