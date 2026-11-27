/**
 * LLMTR is an app-registered OpenAI-compatible gateway, not a built-in Pi
 * provider. It sits beside OpenRouter in Settings → Providers: a prepaid
 * account at https://llmtr.com/v1, model ids in `vendor/model` form, refs
 * `llmtr/<vendor>/<model>`. Pi has no LLMTR catalogue, so unknown ids are
 * synthesized at $0 and billed as a credit pool (see `billingForProvider`).
 *
 * Do not add this to `DIRECT_PROVIDERS` — that table must stay in parity with
 * Pi's registry. The Settings and picker routes append this definition next
 * to the catalogue.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DirectProviderDefinition } from "./provider-catalog.ts";

export const LLMTR_BASE_URL = "https://llmtr.com/v1";
export const LLMTR_KEYS_URL = "https://llmtr.com/dashboard/keys";
export const LLMTR_KEY_ENV = "LLMTR_API_KEY";

const PLAN_NOTE =
  "Prepaid plan or credit pool: Pi prices these models at $0, so Kady records tokens but no USD spend, and the project cap neither counts nor blocks them.";

export const LLMTR_PROVIDER: DirectProviderDefinition = {
  id: "llmtr",
  name: "LLMTR",
  sectionLabel: "LLMTR",
  description: "LLMTR (prepaid OpenAI-compatible gateway)",
  hint: "Prepaid OpenAI-compatible gateway at https://llmtr.com/v1. Create a key under the dashboard, then pick a vendor/model id such as qwen/qwen3.8-27b-free. Usage is recorded but not counted against the project spend cap.",
  keysUrl: LLMTR_KEYS_URL,
  keyEnvVar: LLMTR_KEY_ENV,
  keyLabel: "LLMTR API key",
  extraEnv: [],
  billingMode: "subscription",
  billingNote: PLAN_NOTE,
  synthesizeUnknownIds: true,
  runtimeKey: true,
  oauth: false,
};

export function llmtrConfigured(): boolean {
  return Boolean(process.env[LLMTR_KEY_ENV]?.trim());
}

export function buildLlmtrModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "llmtr",
    baseUrl: LLMTR_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

/** Register (or re-register) the gateway under the current environment key. */
export function registerLlmtrProvider(modelRuntime: ModelRuntime): void {
  modelRuntime.registerProvider("llmtr", {
    name: LLMTR_PROVIDER.name,
    baseUrl: LLMTR_BASE_URL,
    api: "openai-completions",
    apiKey: `$${LLMTR_KEY_ENV}`,
  });
}

/** Map an OpenAI-style `{ data: [{ id }] }` catalogue, skipping blank or duplicate ids. */
export function mapLlmtrCatalog(data: unknown): Model<Api>[] {
  const payload = data && typeof data === "object" ? (data as { data?: unknown }) : {};
  const seen = new Set<string>();
  const models: Model<Api>[] = [];
  for (const entry of Array.isArray(payload.data) ? payload.data : []) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    models.push(buildLlmtrModel(id));
  }
  return models;
}

/**
 * List models from LLMTR's public `/v1/models` catalogue. Returns an empty
 * list when no key is set, the request fails, or the body is unusable — the
 * caller still treats a configured key as connected. The fetch implementation
 * is injectable so tests never contact the network.
 */
export async function fetchLlmtrCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<Model<Api>[]> {
  const key = process.env[LLMTR_KEY_ENV]?.trim();
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const response = await fetchImpl(`${LLMTR_BASE_URL}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return [];
    return mapLlmtrCatalog(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
