/**
 * Context-window discovery for local OpenAI-compatible servers.
 *
 * Pi sizes its output-token reserve from the model's context window, and a
 * wrong value fails quietly in both directions: too small and every run comes
 * back empty (`max_completion_tokens: 1`), too large and the server truncates.
 * One hardcoded default cannot serve a 128K chat model and an 8K embedding
 * model on the same host, so read it off the `/v1/models` listing the picker
 * already fetches — `meta.n_ctx` on llama.cpp, `max_model_len` on vLLM.
 *
 * Not used: llama.cpp's `meta.n_ctx_train` (the model's trained context, not
 * what the server allocated — off by 8x on a 1M-trained model served at 128K)
 * and `/props` (returns `n_ctx: 0` in router mode).
 */
import {
  OPENAI_COMPATIBLE_BASE_URL,
  OPENAI_COMPATIBLE_CONTEXT_WINDOW,
} from "../config.ts";

/**
 * model id -> window reported by the server. Only loaded models appear: a
 * llama.cpp router lists every preset but annotates only live instances, so
 * misses are normal and fall back to the configured default.
 */
const discovered = new Map<string, number>();

/** Sanity bounds. Anything outside is a malformed field, not a real window. */
const MIN_WINDOW = 1_024;
const MAX_WINDOW = 100_000_000;

/** The served window from one `/v1/models` entry, if the server reported one. */
export function contextWindowFromModelEntry(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { max_model_len?: unknown; meta?: unknown };
  // vLLM.
  const vllm = toWindow(e.max_model_len);
  if (vllm !== undefined) return vllm;
  // llama.cpp. `n_ctx` only — see the note on n_ctx_train above.
  const meta = e.meta;
  if (meta && typeof meta === "object") {
    return toWindow((meta as { n_ctx?: unknown }).n_ctx);
  }
  return undefined;
}

function toWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= MIN_WINDOW && n <= MAX_WINDOW ? n : undefined;
}

/**
 * Record what a listing reported. Unannotated entries are left alone rather
 * than cleared: an unloaded model still serves at the same context on demand,
 * so the last known value beats reverting to a guess.
 */
export function noteOpenAICompatibleModels(entries: readonly unknown[]): void {
  for (const entry of entries) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id.trim()) continue;
    const window = contextWindowFromModelEntry(entry);
    if (window !== undefined) discovered.set(id, window);
  }
}

/**
 * Discovery beats OPENAI_COMPATIBLE_CONTEXT_WINDOW: the env var is one global
 * number, so preferring it over a per-model value read from the server would
 * reintroduce the mismatch it exists to fix. It stays the fallback for models
 * the server hasn't loaded, and for LM Studio (which reports context only on
 * its non-standard `/api/v0/models`).
 */
export function openAICompatibleContextWindow(id: string): number {
  return discovered.get(id) ?? OPENAI_COMPATIBLE_CONTEXT_WINDOW;
}

/**
 * Warm the cache at startup so a model ref restored from a saved session is
 * sized correctly even if nobody opened the picker. Failure-tolerant: having no
 * local server is the common case, and the default covers it.
 */
export async function warmOpenAICompatibleContextWindows(): Promise<void> {
  try {
    const resp = await fetch(
      `${OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, "")}/v1/models`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!resp.ok) return;
    const data = (await resp.json()) as { data?: unknown };
    noteOpenAICompatibleModels(Array.isArray(data.data) ? data.data : []);
  } catch {
    // No server, or one that doesn't answer in time. Defaults apply.
  }
}

/** Test seam. */
export function resetOpenAICompatibleContextWindows(): void {
  discovered.clear();
}
