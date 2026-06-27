/**
 * Model resolution for the Pi agent.
 *
 * Two providers are supported, matching the product requirement:
 *   - OpenRouter (built-in Pi provider, key via OPENROUTER_API_KEY)
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
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PROVIDER,
  KADY_MODEL_ACCESS_MODE,
  type ModelAccessMode,
  OLLAMA_BASE_URL,
  REPO_ROOT,
} from "../config.ts";

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

const LOCAL_DEFAULT_PROVIDERS = new Set(["ollama"]);
const LOCAL_REF_PREFIXES = ["ollama/"];
const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function stripThinkingSuffix(ref: string): string {
  const idx = ref.lastIndexOf(":");
  if (idx === -1) return ref;
  const suffix = ref.slice(idx + 1).toLowerCase();
  return THINKING_SUFFIXES.has(suffix) ? ref.slice(0, idx) : ref;
}

function isLocalProvider(provider: string): boolean {
  return LOCAL_DEFAULT_PROVIDERS.has(provider.trim().toLowerCase());
}

function isLocalModelRef(ref: string): boolean {
  const normalized = ref.trim().toLowerCase();
  return LOCAL_REF_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

export function isFreeOpenRouterRef(ref: string): boolean {
  const orId = stripOpenRouter(stripThinkingSuffix(ref.trim()));
  const cat = catalogueEntryFor(orId);
  if (cat) return cat.costInput === 0 && cat.costOutput === 0;
  return orId.endsWith(":free");
}

export function isModelAllowedForMode(
  ref: string | undefined,
  mode: ModelAccessMode = KADY_MODEL_ACCESS_MODE,
  defaultProvider: string = DEFAULT_MODEL_PROVIDER,
): boolean {
  if (mode === "all") return true;

  const usingDefault = !ref || !ref.trim();
  const r = usingDefault ? DEFAULT_MODEL_ID.trim() : ref.trim();
  if (r.startsWith("fusion/")) return false;
  if (isLocalModelRef(r)) return true;
  if (usingDefault && isLocalProvider(defaultProvider)) return true;
  return isFreeOpenRouterRef(r);
}

export function assertModelAllowed(ref: string | undefined): void {
  if (isModelAllowedForMode(ref)) return;
  const label = ref?.trim() || `${DEFAULT_MODEL_PROVIDER}/${DEFAULT_MODEL_ID}`;
  throw new Error(
    `Model policy blocks "${label}". KADY_MODEL_ACCESS_MODE=free-local allows ` +
      `only zero-priced OpenRouter models from web/src/data/models.json and ` +
      `local Ollama models.`,
  );
}

export function firstFreeOpenRouterRef(): string | null {
  for (const [id, cat] of loadCatalogue()) {
    if (cat.costInput === 0 && cat.costOutput === 0) return `openrouter/${id}`;
  }
  return null;
}

/** Panel (analysis) model ids out of a Fusion request body (real schema). */
function fusionPanelModels(fusionConfig: Record<string, unknown>): string[] {
  const plugins = fusionConfig.plugins as Array<Record<string, unknown>> | undefined;
  const panel = plugins?.[0]?.analysis_models;
  return Array.isArray(panel) ? (panel as string[]) : [];
}

/**
 * Build the Pi Model for an OpenRouter Fusion run. The id is "openrouter/fusion"
 * (the wire model the extension rewrites the body to), but its cost MUST be the
 * SUM of the analysis panel models' catalogue prices — otherwise Pi ledgers the
 * turn at $0 (cost flows from model.cost, not the rewritten HTTP body) and the
 * project spend cap is silently bypassed.
 *
 * Throws if the catalogue priced none of the panel models, so the caller can
 * abort the run rather than proceed with a $0-priced (cap-bypassing) Fusion model.
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
  if (priced === 0 || (costInput === 0 && costOutput === 0)) {
    throw new Error(
      "Fusion panel has no priceable models in the catalogue; refusing to run a " +
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

/** Wire provider credentials into AuthStorage from the environment. */
export function setupAuth(authStorage: AuthStorage): void {
  const orKey = process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY;
  if (orKey) authStorage.setRuntimeApiKey("openrouter", orKey);
  // Local Ollama ignores the key, but Pi requires *some* auth to resolve.
  authStorage.setRuntimeApiKey("ollama", "ollama");
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
  const r = usingDefault ? DEFAULT_MODEL_ID.trim() : ref.trim();
  assertModelAllowed(usingDefault ? undefined : r);
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
  // .env.example documents a bare DEFAULT_MODEL_ID (e.g. "llama3") routed by
  // DEFAULT_MODEL_PROVIDER; honor that instead of misrouting to OpenRouter.
  if (usingDefault && DEFAULT_MODEL_PROVIDER.toLowerCase() === "ollama") {
    return buildOllamaModel(r);
  }
  const orId = stripOpenRouter(r);
  return registry.find("openrouter", orId) ?? buildOpenRouterModel(orId);
}

export function defaultModel(registry: ModelRegistry): Model<Api> {
  try {
    return resolveModel(undefined, registry);
  } catch (err) {
    if (KADY_MODEL_ACCESS_MODE === "free-local") {
      const fallback = firstFreeOpenRouterRef();
      if (fallback) return resolveModel(fallback, registry);
    }
    throw err;
  }
}
