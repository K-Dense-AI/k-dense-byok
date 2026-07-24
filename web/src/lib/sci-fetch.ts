/**
 * Bounded fetch for the scientific preview endpoints.
 *
 * The Python helpers behind /sandbox/sci-summary have their own 60s ceiling,
 * but a stalled socket or a genuinely huge file left the viewer spinning
 * forever with no way out except closing the tab. Every viewer request gets a
 * deadline and is aborted when the panel unmounts, so switching files doesn't
 * leave work in flight either.
 */

/** Slightly above the server-side helper timeout so its error text wins. */
export const SCI_FETCH_TIMEOUT_MS = 70_000;

export class SciTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Preview timed out after ${seconds}s — the file may be too large.`);
    this.name = "SciTimeoutError";
  }
}

async function bounded(
  url: string,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new SciTimeoutError(Math.round(timeoutMs / 1000));
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/** GET a helper JSON summary, surfacing the backend's `detail` on failure. */
export async function fetchSciJson<T>(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const res = await bounded(url, opts.timeoutMs ?? SCI_FETCH_TIMEOUT_MS, opts.signal);
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(detail.detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET a raw sandbox file as text under the same deadline. */
export async function fetchSciText(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const res = await bounded(url, opts.timeoutMs ?? SCI_FETCH_TIMEOUT_MS, opts.signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** True for aborts caused by unmount/navigation, which must not show an error. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
