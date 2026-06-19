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

function buildOpenRouterModel(orId: string): Model<Api> {
  const cat = loadCatalogue().get(orId);
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
): Model<Api> {
  const usingDefault = !ref || !ref.trim();
  const r = usingDefault ? DEFAULT_MODEL_ID.trim() : ref.trim();
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
  return resolveModel(DEFAULT_MODEL_ID, registry);
}
