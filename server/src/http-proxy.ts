/**
 * Proxy-aware global HTTP dispatcher for the backend process.
 *
 * Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY / NO_PROXY unless the
 * process is started with NODE_USE_ENV_PROXY, which only exists on Node >= 24
 * (the launcher supports >= 22.19). Pi's own CLI installs undici's
 * EnvHttpProxyAgent at startup, so the child `pi` processes that run subagents
 * already honour those variables — but Kady embeds the SDK for the lead agent
 * and `configureHttpDispatcher` is not part of pi-coding-agent's public
 * exports. Without the equivalent here, the lead agent, Fusion, and speech
 * transcription silently bypass a proxy that the rest of the app — and the
 * user's other tools — route through.
 *
 * This is a no-op unless a proxy variable is actually set, so the default
 * (direct-connection) path keeps using Node's own dispatcher untouched.
 */
import { EventEmitter } from "node:events";
import * as undici from "undici";

/** Captured at module load, before anything can swap the global. */
const originalFetch = globalThis.fetch;

export interface HttpProxyStatus {
  /** True when a proxy dispatcher was installed for this process. */
  enabled: boolean;
  /** Redacted `http_proxy`/`HTTP_PROXY` value, if set. */
  httpProxy?: string;
  /** Redacted `https_proxy`/`HTTPS_PROXY` value, if set. */
  httpsProxy?: string;
  /** Raw `no_proxy`/`NO_PROXY` value, if set (host patterns — nothing to redact). */
  noProxy?: string;
}

/** Lowercase wins over uppercase, matching undici's own precedence. */
function readEnvPair(
  env: NodeJS.ProcessEnv,
  lower: string,
  upper: string,
): string | undefined {
  return env[lower]?.trim() || env[upper]?.trim() || undefined;
}

/**
 * Strip credentials from a proxy URL so it can be logged. Proxy URLs routinely
 * carry `user:password@`, and the boot log is the first thing a user pastes
 * into a bug report.
 */
export function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "(unparseable proxy URL)";
  }
}

const ignoreDispatcherError = (): void => {};

/**
 * Undici can emit an internal Client "error" while tearing down a fetch body
 * mid-stream, which Kady does on every stopped run. The body stream still
 * rejects through its reader; this listener only prevents EventEmitter's
 * unhandled-"error" special case from taking the process down. Mirrors the
 * listener pi attaches in its own dispatcher setup.
 */
function withErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
  }
  return dispatcher;
}

function createClient(origin: string | URL, options: unknown): undici.Client {
  return withErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createOriginDispatcher(origin: string | URL, options: unknown): undici.Dispatcher {
  const opts = options as undici.Pool.Options & { connections?: number };
  if (opts.connections === 1) return createClient(origin, opts);
  return withErrorListener(new undici.Pool(origin, { ...opts, factory: createClient }));
}

let status: HttpProxyStatus | null = null;

const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

/**
 * NO_PROXY plus loopback. undici's EnvHttpProxyAgent does not bypass
 * loopback on its own, so with a corporate proxy set, calls to a local
 * Ollama / LM Studio and the child processes' calls back into this API —
 * which carry the access token — would be sent to the proxy.
 */
export function withLoopbackNoProxy(noProxy: string | undefined): string {
  const entries = (noProxy ?? "").split(/[\s,]+/).filter(Boolean);
  if (entries.includes("*")) return noProxy!.trim();
  const have = new Set(entries.map((e) => e.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY) if (!have.has(host)) entries.push(host);
  return entries.join(",");
}

/**
 * Install a proxy-aware global dispatcher when the environment asks for one.
 * Idempotent; returns what was (or wasn't) configured so the caller can log it.
 */
export function configureHttpProxy(env: NodeJS.ProcessEnv = process.env): HttpProxyStatus {
  if (status) return status;

  const httpProxy = readEnvPair(env, "http_proxy", "HTTP_PROXY");
  const httpsProxy = readEnvPair(env, "https_proxy", "HTTPS_PROXY");
  const noProxy = readEnvPair(env, "no_proxy", "NO_PROXY");

  if (!httpProxy && !httpsProxy) {
    status = { enabled: false, ...(noProxy ? { noProxy } : {}) };
    return status;
  }

  // Children (the pi-subagents runner installs the same agent from env) get
  // the loopback bypass too.
  const effectiveNoProxy = withLoopbackNoProxy(noProxy);
  env.NO_PROXY = effectiveNoProxy;
  env.no_proxy = effectiveNoProxy;

  // Values are passed explicitly rather than left to undici's own process.env
  // read, so the `env` argument is authoritative (and tests are deterministic).
  const dispatcher = withErrorListener(
    new undici.EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy: effectiveNoProxy,
      allowH2: false,
      clientFactory: createClient,
      factory: createOriginDispatcher,
    } as undici.EnvHttpProxyAgent.Options),
  );
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and the dispatcher on one undici implementation. Node's bundled
  // fetch is a *different copy* of undici from this package, and handing it a
  // foreign dispatcher can mismatch the response handler interface (Node 26.0
  // consumes compressed bodies without decompressing them). Only swap the
  // globals if nothing else already replaced fetch.
  if (globalThis.fetch === originalFetch) undici.install?.();

  status = {
    enabled: true,
    ...(httpProxy ? { httpProxy: redactProxyUrl(httpProxy) } : {}),
    ...(httpsProxy ? { httpsProxy: redactProxyUrl(httpsProxy) } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
  return status;
}
