/**
 * Custom model servers: Pi's `models.json` in Kady's agent dir.
 *
 * `ModelRuntime.create` reads `<agentDir>/models.json` and `refresh()`
 * re-reads it, so a provider added here becomes a first-class Pi provider
 * (its models get `Model.provider === "<id>"`) without a restart. This lets a
 * lab point Kady at an institutional vLLM/HPC gateway with real pricing,
 * context window and thinking metadata — unlike the $0 Ollama/LM Studio paths.
 *
 * Kady tracks the providers it wrote in a sidecar manifest so a models.json
 * the user shares with a standalone Pi keeps its hand-written providers: a
 * PUT replaces only Kady-managed entries. Provider ids must not collide with
 * providers Kady already knows (catalogue, OAuth, OpenRouter, local servers).
 *
 * Billing: custom providers are `payg` at their declared cost (`billing.ts`
 * default), so a $0-priced local server ledgers $0 and a priced gateway counts
 * toward the project cap.
 */
import fs from "node:fs";
import path from "node:path";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isDirectProvider } from "./provider-catalog.ts";
import { isSubscriptionProvider, tierFor, type ClientDirectModel } from "./provider-auth.ts";

export const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const CUSTOM_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomModelApi = (typeof CUSTOM_MODEL_APIS)[number];
const RESERVED_PROVIDER_IDS = new Set(["openrouter", "ollama", "openai-compatible", "fusion", "nvidia", "modal", "kady"]);
const MAX_PROVIDERS = 20;
const MAX_MODELS_PER_PROVIDER = 100;

export interface CustomModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  /** USD per million tokens, Pi's convention. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CustomProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomModelApi;
  /** Literal key, `$ENV_VAR`, or empty for keyless servers (Pi needs *something*; we write "none"). */
  apiKey?: string;
  models: CustomModelDefinition[];
}

export interface CustomProviderListing extends CustomProvider {
  /** Written by Kady (editable) vs hand-written in models.json (read-only here). */
  managed: boolean;
}

export function modelsJsonPath(agentDir = KADY_PI_AGENT_DIR): string {
  return path.join(agentDir, "models.json");
}

function manifestPath(agentDir = KADY_PI_AGENT_DIR): string {
  return path.join(agentDir, "kady-custom-models.json");
}

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

function readJson(file: string): Rec | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

function managedIds(agentDir = KADY_PI_AGENT_DIR): Set<string> {
  const manifest = readJson(manifestPath(agentDir)) ?? {};
  return new Set(Array.isArray(manifest.managed) ? manifest.managed.filter((x): x is string => typeof x === "string") : []);
}

function providerFromJson(id: string, raw: Rec): CustomProvider {
  const models = Array.isArray(raw.models) ? raw.models : [];
  return {
    id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    api: (CUSTOM_MODEL_APIS as readonly string[]).includes(String(raw.api)) ? (raw.api as CustomModelApi) : "openai-completions",
    ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}),
    models: models
      .map((m) => asRecord(m))
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        id: m.id as string,
        ...(typeof m.name === "string" ? { name: m.name } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(Array.isArray(m.input) ? { input: m.input.filter((x): x is "text" | "image" => x === "text" || x === "image") } : {}),
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
        ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
        ...(m.cost && typeof m.cost === "object"
          ? {
              cost: {
                input: Number(asRecord(m.cost).input ?? 0),
                output: Number(asRecord(m.cost).output ?? 0),
                cacheRead: Number(asRecord(m.cost).cacheRead ?? 0),
                cacheWrite: Number(asRecord(m.cost).cacheWrite ?? 0),
              },
            }
          : {}),
      })),
  };
}

/** Every provider in models.json, flagged managed/foreign. Malformed file → []. */
export function listCustomProviders(agentDir = KADY_PI_AGENT_DIR): CustomProviderListing[] {
  const file = readJson(modelsJsonPath(agentDir));
  if (!file) return [];
  const managed = managedIds(agentDir);
  return Object.entries(asRecord(file.providers)).map(([id, raw]) => ({
    ...providerFromJson(id, asRecord(raw)),
    managed: managed.has(id),
  }));
}

let idCache: { mtimeMs: number; ids: Set<string> } | null = null;

/** Provider ids defined in models.json, cached by file mtime (hot path: ref parsing). */
export function customProviderIds(agentDir = KADY_PI_AGENT_DIR): Set<string> {
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(modelsJsonPath(agentDir)).mtimeMs;
  } catch {
    idCache = { mtimeMs: -1, ids: new Set() };
    return idCache.ids;
  }
  if (idCache && idCache.mtimeMs === mtimeMs) return idCache.ids;
  const ids = new Set(Object.keys(asRecord((readJson(modelsJsonPath(agentDir)) ?? {}).providers)));
  idCache = { mtimeMs, ids };
  return ids;
}

export function isCustomProvider(providerId: string, agentDir = KADY_PI_AGENT_DIR): boolean {
  return customProviderIds(agentDir).has(providerId);
}

export function customProviderName(providerId: string, agentDir = KADY_PI_AGENT_DIR): string {
  const raw = asRecord(asRecord((readJson(modelsJsonPath(agentDir)) ?? {}).providers)[providerId]);
  return typeof raw.name === "string" && raw.name.trim() ? raw.name : providerId;
}

/** Validate a submitted provider list; returns normalized providers or an error string. */
export function validateCustomProviders(input: unknown): CustomProvider[] | string {
  if (!Array.isArray(input)) return "providers must be an array";
  if (input.length > MAX_PROVIDERS) return `at most ${MAX_PROVIDERS} custom providers`;
  const out: CustomProvider[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const p = asRecord(raw);
    const id = String(p.id ?? "").trim();
    if (!CUSTOM_PROVIDER_ID_RE.test(id)) return `invalid provider id "${id}" (lowercase letters, digits, dashes; 2–41 chars)`;
    if (RESERVED_PROVIDER_IDS.has(id) || isDirectProvider(id) || isSubscriptionProvider(id)) {
      return `provider id "${id}" is already a built-in Kady provider`;
    }
    if (seen.has(id)) return `duplicate provider id "${id}"`;
    seen.add(id);
    const baseUrl = String(p.baseUrl ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return `provider "${id}": baseUrl must be an http(s) URL`;
    const api = String(p.api ?? "openai-completions");
    if (!(CUSTOM_MODEL_APIS as readonly string[]).includes(api)) {
      return `provider "${id}": api must be one of ${CUSTOM_MODEL_APIS.join(", ")}`;
    }
    const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    if (apiKey.length > 512) return `provider "${id}": apiKey is too long`;
    if (!Array.isArray(p.models) || p.models.length === 0) return `provider "${id}": at least one model is required`;
    if (p.models.length > MAX_MODELS_PER_PROVIDER) return `provider "${id}": at most ${MAX_MODELS_PER_PROVIDER} models`;
    const models: CustomModelDefinition[] = [];
    const modelIds = new Set<string>();
    for (const rawModel of p.models) {
      const m = asRecord(rawModel);
      const modelId = String(m.id ?? "").trim();
      if (!modelId || modelId.length > 200 || /\s/.test(modelId)) return `provider "${id}": invalid model id "${modelId}"`;
      if (modelIds.has(modelId)) return `provider "${id}": duplicate model id "${modelId}"`;
      modelIds.add(modelId);
      const num = (v: unknown, label: string, min: number, max: number): number | string | undefined => {
        if (v === undefined || v === null || v === "") return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) return `provider "${id}", model "${modelId}": ${label} out of range`;
        return n;
      };
      const contextWindow = num(m.contextWindow, "contextWindow", 1_000, 100_000_000);
      if (typeof contextWindow === "string") return contextWindow;
      const maxTokens = num(m.maxTokens, "maxTokens", 1, 10_000_000);
      if (typeof maxTokens === "string") return maxTokens;
      let cost: CustomModelDefinition["cost"];
      if (m.cost && typeof m.cost === "object") {
        const c = asRecord(m.cost);
        const parts: Record<string, number> = {};
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const v = num(c[key] ?? 0, `cost.${key}`, 0, 10_000);
          if (typeof v === "string") return v;
          parts[key] = v ?? 0;
        }
        cost = parts as CustomModelDefinition["cost"];
      }
      const input = Array.isArray(m.input) ? m.input.filter((x): x is "text" | "image" => x === "text" || x === "image") : undefined;
      models.push({
        id: modelId,
        ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(input && input.length > 0 ? { input } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(cost ? { cost } : {}),
      });
    }
    out.push({
      id,
      ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim() } : {}),
      baseUrl,
      api: api as CustomModelApi,
      ...(apiKey ? { apiKey } : {}),
      models,
    });
  }
  return out;
}

/**
 * Replace Kady-managed providers with `providers`, keeping every foreign
 * provider and other top-level key. Returns the resulting listing, or null if
 * models.json is malformed (left untouched — the caller reports 409).
 */
export function writeCustomProviders(providers: CustomProvider[], agentDir = KADY_PI_AGENT_DIR): CustomProviderListing[] | null {
  const file = readJson(modelsJsonPath(agentDir));
  if (file === null) return null;
  const managed = managedIds(agentDir);
  const existing = asRecord(file.providers);
  const next: Rec = {};
  for (const [id, raw] of Object.entries(existing)) {
    if (!managed.has(id)) next[id] = raw; // foreign: untouched
  }
  for (const p of providers) {
    if (existing[p.id] && !managed.has(p.id)) {
      // Never silently take over a hand-written provider.
      return null;
    }
    next[p.id] = {
      ...(p.name ? { name: p.name } : {}),
      baseUrl: p.baseUrl,
      api: p.api,
      // Pi only lists models of providers whose auth resolved: keyless servers
      // need a placeholder, exactly like Kady's own ollama registration.
      apiKey: p.apiKey || "none",
      models: p.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.input ? { input: m.input } : {}),
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.cost ? { cost: m.cost } : {}),
      })),
    };
  }
  fs.mkdirSync(agentDir, { recursive: true });
  const target = modelsJsonPath(agentDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...file, providers: next }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
  fs.writeFileSync(manifestPath(agentDir), JSON.stringify({ managed: providers.map((p) => p.id) }, null, 2) + "\n", "utf-8");
  idCache = null;
  return listCustomProviders(agentDir);
}

export const CUSTOM_SECTION_LABEL = "Custom servers";

/** Picker row for a model served by a custom provider (payg at declared cost). */
export function customModelForClient(model: Model<Api>, provider: CustomProviderListing): ClientDirectModel {
  return {
    id: `${provider.id}/${model.id}`,
    label: model.name,
    provider: provider.name ?? provider.id,
    sourceId: provider.id,
    sourceLabel: CUSTOM_SECTION_LABEL,
    tier: tierFor(model),
    context_length: model.contextWindow,
    pricing: { prompt: model.cost.input, completion: model.cost.output },
    modality: model.input.includes("image") ? "text+image->text" : "text->text",
    description: `Custom model server at ${provider.baseUrl}`,
    reasoning: model.reasoning,
    billingMode: "payg",
    available: true,
  };
}
