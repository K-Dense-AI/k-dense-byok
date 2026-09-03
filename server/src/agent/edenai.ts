/**
 * Eden AI (https://www.edenai.co) as a first-class Kady model provider.
 *
 * Eden's V3 API is an OpenAI chat-completions gateway
 * (`https://api.edenai.run/v3/chat/completions`) fronting many upstream
 * vendors under `<vendor>/<model>` ids, so Pi talks to it through the standard
 * `openai-completions` adapter — there is no Eden-specific wire protocol here.
 *
 * Two things make it a dedicated path rather than an OPENAI_COMPATIBLE_BASE_URL
 * configuration:
 *
 *   1. It is a *paid* gateway with real per-token USD pricing, so its models
 *      must carry true `cost` values (Pi computes `usage.cost` from them, and
 *      that is what the project spend cap consumes). Pricing $0 would silently
 *      disable the cap — the same hazard `models.ts` documents for OpenRouter.
 *   2. Its catalogue is dynamic (~1000 models, discovered from `/v3/models`),
 *      so it is deliberately NOT added to `web/src/data/models.json`, which is
 *      the checked-in OpenRouter catalogue.
 *
 * Model refs are `edenai/<full Eden model id>`. Eden ids frequently contain
 * further slashes (`fireworks_ai/accounts/fireworks/models/…`), so only the
 * FIRST `edenai/` segment is ever stripped — see `stripEdenaiRef`.
 */
import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { EDENAI_BASE_URL, KADY_PI_AGENT_DIR } from "../config.ts";

export const EDENAI_PROVIDER_ID = "edenai";
const EDENAI_REF_PREFIX = `${EDENAI_PROVIDER_ID}/`;

/** Eden reports no per-model output cap, so every model uses Kady's default. */
const DEFAULT_MAX_TOKENS = 8192;
/** `context_length` is null for a minority of rows; match the OpenRouter fallback. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Snapshot of the last successful discovery. Model resolution is synchronous
 * (`resolveModel`), so without a warm catalogue a run started before the first
 * discovery — a fresh process, a subagent, a persisted ref after a restart —
 * would price at $0 and stop accruing against the project spend cap. The
 * snapshot is a cache, never authoritative: a background refresh replaces it
 * on startup and every discovery request.
 */
const SNAPSHOT_PATH = path.join(KADY_PI_AGENT_DIR, "edenai-models.json");

/**
 * The credential. Read at call time, never captured: `PUT /credentials` writes
 * `EDENAI_API_KEY` into `process.env` so a key added in Settings takes effect
 * without restarting the server.
 */
export function edenaiApiKey(): string | null {
  const raw = process.env.EDENAI_API_KEY;
  return raw && raw.trim() ? raw.trim() : null;
}

export function edenaiConfigured(): boolean {
  return edenaiApiKey() !== null;
}

/** The base URL actually used for requests, without a trailing slash. */
export function edenaiBaseUrl(): string {
  return EDENAI_BASE_URL.replace(/\/+$/, "");
}

/**
 * Strip only the leading `edenai/` from a model ref. Everything after it is
 * the Eden model id verbatim, slashes included — splitting on `/` would
 * truncate `edenai/fireworks_ai/accounts/fireworks/models/x` to two segments
 * and request a model that does not exist.
 */
export function stripEdenaiRef(ref: string): string {
  return ref.startsWith(EDENAI_REF_PREFIX) ? ref.slice(EDENAI_REF_PREFIX.length) : ref;
}

export function isEdenaiRef(ref: string): boolean {
  return ref.startsWith(EDENAI_REF_PREFIX);
}

/** Kady's view of one Eden catalogue row. Costs are USD per 1M tokens. */
export interface EdenaiModelInfo {
  /** Eden model id as sent to the API, e.g. "openai/gpt-4o-mini". */
  id: string;
  label: string;
  ownedBy: string;
  contextWindow: number;
  costInput: number;
  costOutput: number;
  cacheRead: number;
  cacheWrite: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  /**
   * `capabilities.supports_function_calling`. Kady sends tool definitions on
   * every turn, so this gates what the picker offers — the same rule the
   * OpenRouter catalogue is generated with.
   */
  functionCalling: boolean;
}

/** Eden prices per token; Pi's `Model.cost` is USD per 1M tokens. */
function perMillion(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
}

/**
 * Read one catalogue row defensively. Eden's `pricing` object carries a long
 * tail of optional keys (tiered, audio, image, per-second, above-N-token
 * variants); only the four scalar token costs Pi models have a slot for are
 * read, by name, so an unfamiliar shape degrades rather than throws.
 */
function parseEdenaiModel(entry: unknown): EdenaiModelInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;

  const capabilities = (row.capabilities ?? {}) as Record<string, unknown>;
  // The effective (account) pricing, not `list_pricing` — Eden applies a
  // per-account discount and the ledger must record what is actually charged.
  const pricing = (row.pricing ?? {}) as Record<string, unknown>;
  const modalities = Array.isArray(capabilities.input_modalities)
    ? (capabilities.input_modalities as unknown[]).map(String)
    : [];

  return {
    id,
    label: typeof row.model_name === "string" && row.model_name.trim() ? row.model_name : id,
    ownedBy: typeof row.owned_by === "string" ? row.owned_by : "",
    contextWindow: Number(row.context_length) > 0
      ? Number(row.context_length)
      : DEFAULT_CONTEXT_WINDOW,
    costInput: perMillion(pricing.input_cost_per_token),
    costOutput: perMillion(pricing.output_cost_per_token),
    cacheRead: perMillion(pricing.cache_read_input_token_cost),
    cacheWrite: perMillion(pricing.cache_creation_input_token_cost),
    // Pi models only distinguish text and image inputs; Eden's "video",
    // "file", and "audio" modalities have no Pi slot and are dropped.
    input: modalities.includes("image") ? ["text", "image"] : ["text"],
    reasoning: capabilities.supports_reasoning === true,
    functionCalling: capabilities.supports_function_calling === true,
  };
}

/** Parse a `/v3/models` payload, skipping rows that carry no usable id. */
export function parseEdenaiModels(payload: unknown): EdenaiModelInfo[] {
  const data = (payload as { data?: unknown } | null)?.data;
  const out: EdenaiModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(data) ? data : []) {
    const model = parseEdenaiModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Fetch Eden's live catalogue. The key is sent because Eden's effective
 * pricing is account-specific (it applies a per-account discount), so an
 * unauthenticated list would ledger the wrong price.
 */
export async function fetchEdenaiModels(): Promise<EdenaiModelInfo[]> {
  const key = edenaiApiKey();
  if (!key) throw new Error("Eden AI is not configured (EDENAI_API_KEY is unset)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${edenaiBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Eden AI model discovery failed (HTTP ${response.status})`);
    }
    return parseEdenaiModels(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

let cache: { models: EdenaiModelInfo[]; loadedAt: number } | null = null;
let inFlight: Promise<EdenaiModelInfo[]> | null = null;
let snapshotRead = false;

function readSnapshot(): EdenaiModelInfo[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8")) as unknown;
    const models = Array.isArray((raw as { models?: unknown })?.models)
      ? ((raw as { models: unknown[] }).models as EdenaiModelInfo[])
      : null;
    return models && models.length > 0 ? models : null;
  } catch {
    return null; // No snapshot yet, or an unreadable one — discovery will replace it.
  }
}

function writeSnapshot(models: EdenaiModelInfo[]): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify({ savedAt: Date.now(), baseUrl: edenaiBaseUrl(), models }),
      "utf-8",
    );
  } catch {
    /* A cache write failure must not fail discovery. */
  }
}

/** The catalogue in memory, falling back to the on-disk snapshot once. */
function warmModels(): EdenaiModelInfo[] {
  if (cache) return cache.models;
  if (!snapshotRead) {
    snapshotRead = true;
    const snapshot = readSnapshot();
    if (snapshot) cache = { models: snapshot, loadedAt: 0 };
  }
  return cache?.models ?? [];
}

/**
 * Discovered models, from cache when fresh. Concurrent callers share one
 * request; a failed refresh leaves any previous catalogue in place rather than
 * emptying the picker.
 */
export async function edenaiCatalogue(force = false): Promise<EdenaiModelInfo[]> {
  if (!force && cache && cache.loadedAt > 0 && Date.now() - cache.loadedAt < CATALOGUE_TTL_MS) {
    return cache.models;
  }
  if (inFlight) return inFlight;
  const request = fetchEdenaiModels()
    .then((models) => {
      cache = { models, loadedAt: Date.now() };
      snapshotRead = true;
      writeSnapshot(models);
      return models;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

/** Synchronous metadata lookup for `resolveModel`; undefined when cold. */
export function edenaiModelInfo(id: string): EdenaiModelInfo | undefined {
  return warmModels().find((model) => model.id === id);
}

/**
 * Kick off a background refresh. Called once at startup so a cold process has
 * real pricing before the first run, without blocking boot on Eden's API.
 */
export function warmEdenaiCatalogue(): void {
  if (!edenaiConfigured()) return;
  void edenaiCatalogue().catch(() => {
    /* Discovery is best-effort; the route surfaces the error to the user. */
  });
}

/** Drop the cache so the next read re-discovers (used when the key changes). */
export function invalidateEdenaiCatalogue(): void {
  cache = null;
  inFlight = null;
  snapshotRead = false;
}

/** Test seam: set the in-memory catalogue without touching the network. */
export function setEdenaiCatalogueForTests(models: EdenaiModelInfo[] | null): void {
  cache = models ? { models, loadedAt: Date.now() } : null;
  inFlight = null;
  snapshotRead = true;
}

/**
 * Compatibility overrides for Eden's gateway.
 *
 * Pi auto-detects these from the base URL, and an unrecognized host is treated
 * as api.openai.com — which is wrong for Eden in four places. Each override
 * below corresponds to a parameter Eden's V3 chat-completions API documents (or
 * does not); nothing here is inferred from a live response.
 */
const EDENAI_COMPAT: NonNullable<Model<"openai-completions">["compat"]> = {
  // Eden documents the `system` role (system/user/assistant/tool). It does not
  // document OpenAI's `developer` role, which Pi would otherwise use for the
  // system prompt on every reasoning-capable model.
  supportsDeveloperRole: false,
  // `store` is an OpenAI-hosted-conversation flag and is not part of Eden's
  // documented request schema.
  supportsStore: false,
  // Eden documents both `max_tokens` and `max_completion_tokens`; `max_tokens`
  // is the form every upstream vendor behind the gateway accepts.
  maxTokensField: "max_tokens",
  // Tool definitions are documented as {type, function:{name,description,
  // parameters}}. `strict` is not, so it is omitted entirely rather than sent
  // as false to ~1000 heterogeneous upstream models.
  supportsStrictMode: false,
  // Eden documents `reasoning_effort` with the values Pi already emits
  // (minimal/low/medium/high/xhigh/max). "openai" is the format that sends it
  // as a top-level string.
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
};

/**
 * Build the Pi Model for an Eden model id (the ref with `edenai/` stripped).
 *
 * Metadata comes from the discovered catalogue. When it is cold the model
 * still runs, but at $0 — which stops the project spend cap from accruing, so
 * that case warns exactly as the OpenRouter catalogue path does.
 */
export function buildEdenaiModel(id: string, info?: EdenaiModelInfo): Model<Api> {
  const meta = info ?? edenaiModelInfo(id);
  if (!meta) {
    console.warn(
      `[edenai] No discovered metadata for "${id}" — pricing it at $0, so this ` +
        `run will not accrue against the project spend limit. It is priced ` +
        `correctly once Eden model discovery succeeds (needs EDENAI_API_KEY).`,
    );
  }
  const model: Model<"openai-completions"> = {
    id,
    name: meta?.label ?? id,
    api: "openai-completions",
    provider: EDENAI_PROVIDER_ID,
    baseUrl: edenaiBaseUrl(),
    // Pi clamps the thinking level to what the model supports; `false` here
    // means no reasoning parameter is ever sent for that model.
    reasoning: meta?.reasoning ?? false,
    input: meta?.input ?? ["text"],
    cost: {
      input: meta?.costInput ?? 0,
      output: meta?.costOutput ?? 0,
      cacheRead: meta?.cacheRead ?? 0,
      cacheWrite: meta?.cacheWrite ?? 0,
    },
    contextWindow: meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: EDENAI_COMPAT,
  };
  // `Model<Api>` resolves `compat` to `never` (the field is keyed off a single
  // concrete api), so the concrete openai-completions model is widened here.
  // Every caller only reads the shared fields.
  return model as Model<Api>;
}

/**
 * The models offered in the picker: text-capable and tool-calling only.
 *
 * Kady attaches tool definitions to every turn, so a model without
 * `supports_function_calling` cannot run the agent loop — the same reason
 * `web/src/data/models.json` is generated from tool-calling OpenRouter models.
 * The cache deliberately keeps every row so a persisted ref to an excluded
 * model still prices correctly.
 */
export function edenaiPickerModels(models: EdenaiModelInfo[]): EdenaiModelInfo[] {
  return models.filter((model) => model.functionCalling);
}
