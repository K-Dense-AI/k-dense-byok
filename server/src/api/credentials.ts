/**
 * Runtime credential management for the bring-your-own-key model.
 *
 * Historically the only way to set a key was to edit the repo-root `.env` and
 * restart the app — a real wall for a non-technical scientist. These endpoints
 * let the Settings UI read key status and set keys live:
 *   - GET  /credentials  → masked status per provider (never the raw key)
 *   - PUT  /credentials  → set/clear any subset of keys, persist to `.env`,
 *                          and update process.env so in-flight sessions (and
 *                          the child `pi` processes pi-subagents spawns, which
 *                          inherit our environment) pick them up without a
 *                          restart. Saving a model key selects API-key auth
 *                          by removing any previous stored Pi credential.
 *
 * Managed keys: OpenRouter (model calls and cross-browser speech
 * transcription); every direct Pi model provider from
 * `agent/provider-catalog.ts` (its API key plus any supporting configuration
 * such as a Cloudflare account id or an Azure endpoint — generated below, one
 * entry per distinct env var, since several providers share one); the
 * optional pi-web-access search providers — Exa, Perplexity, Gemini (web
 * search works without any of the three via the Exa MCP fallback; a key
 * unlocks the direct provider, and Gemini also unlocks YouTube/video
 * understanding — and GEMINI_API_KEY is the same variable Pi's `google`
 * provider reads, so it also enables Gemini models); and the Modal
 * remote-compute token pair (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) that enables
 * the `modal_run` tool; and the local model-server URLs (OLLAMA_BASE_URL,
 * OPENAI_COMPATIBLE_BASE_URL), which re-register those providers on change.
 *
 * Keys are stored exactly where the app already expects them (repo-root
 * `.env`, plaintext, on the user's own machine) — we are removing friction,
 * not changing the trust model. The server binds to localhost only.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { REPO_ROOT } from "../config.ts";
import { getModelRuntime } from "../agent/session-registry.ts";
import { registerLocalProviders } from "../agent/models.ts";
import {
  DIRECT_PROVIDERS,
  providerKeyBodyField,
} from "../agent/provider-catalog.ts";
import { validateModalCredentials } from "../modal/adapter.ts";
import { modalJobManager } from "../modal/manager.ts";
import { notebookRobustness } from "../agent/notebook-robustness.ts";

const ENV_PATH = path.join(REPO_ROOT, ".env");
let credentialEnvPath = ENV_PATH;

interface ManagedKey {
  /** Provider id in API payloads (GET response field). */
  id: string;
  /** PUT body field name. */
  bodyField: string;
  /** Canonical env var written to `.env`. */
  envVar: string;
  /** Extra env vars read (and cleared) for backwards compatibility. */
  envAliases?: string[];
  /**
   * Secrets are masked in status replies and must be ≥ 8 chars; configuration
   * values (regions, account ids, endpoints) are echoed back in full and may be
   * short (`global`, `us-east-1`).
   */
  secret?: boolean;
  /** Format check for a non-empty value; returns an error message or null. */
  validate?: (value: string) => string | null;
  /** Hook run after set/clear (e.g. select the model authentication method). */
  onChange?: (key: string | null, runtime: ModelRuntime) => Promise<void>;
}

/** Select environment-key auth in every Pi process, including after restart. */
function runtimeKeyHook(providerIds: readonly string[]): ManagedKey["onChange"] {
  return async (key, runtime) => {
    for (const providerId of providerIds) {
      // An explicit key save switches away from a stored OAuth/API-key
      // credential. Runtime-only overrides would mask later sign-ins and
      // disagree with child processes and restarted servers. Clearing an
      // ambient key must leave an independently connected OAuth login intact.
      if (key) await runtime.logout(providerId);
      else await runtime.removeRuntimeApiKey(providerId);
    }
  };
}

/** Accept only an absolute http(s) URL, so a typo fails here instead of at the first model call. */
function httpUrl(envVar: string): ManagedKey["validate"] {
  return (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `${envVar} must be an http(s) URL`;
    }
    return url.protocol === "http:" || url.protocol === "https:"
      ? null
      : `${envVar} must be an http(s) URL`;
  };
}

/**
 * Re-register the local model servers after their base URL changed (or was
 * cleared back to the default). config.ts reads both URLs per call, so this
 * only refreshes Pi's provider registration.
 */
async function localProvidersHook(_key: string | null, runtime: ModelRuntime): Promise<void> {
  try {
    registerLocalProviders(runtime);
  } catch {
    /* Runtime refresh failure does not undo the persisted environment change. */
  }
}

const BASE_MANAGED_KEYS: ManagedKey[] = [
  {
    id: "openrouter",
    bodyField: "openrouterApiKey",
    envVar: "OPENROUTER_API_KEY",
    envAliases: ["OR_API_KEY"],
    onChange: runtimeKeyHook(["openrouter"]),
  },
  { id: "exa", bodyField: "exaApiKey", envVar: "EXA_API_KEY" },
  { id: "perplexity", bodyField: "perplexityApiKey", envVar: "PERPLEXITY_API_KEY" },
  { id: "gemini", bodyField: "geminiApiKey", envVar: "GEMINI_API_KEY" },
  // Modal remote compute is two env vars for one logical credential; both must
  // be set for modalConfigured() to flip true and the modal_run tool to register.
  { id: "modalTokenId", bodyField: "modalTokenId", envVar: "MODAL_TOKEN_ID" },
  { id: "modalTokenSecret", bodyField: "modalTokenSecret", envVar: "MODAL_TOKEN_SECRET" },
  // Local model servers: configuration, not secrets, so echoed in full.
  {
    id: "ollamaBaseUrl",
    bodyField: "ollamaBaseUrl",
    envVar: "OLLAMA_BASE_URL",
    secret: false,
    validate: httpUrl("OLLAMA_BASE_URL"),
    onChange: localProvidersHook,
  },
  {
    id: "openaiCompatibleBaseUrl",
    bodyField: "openaiCompatibleBaseUrl",
    envVar: "OPENAI_COMPATIBLE_BASE_URL",
    secret: false,
    validate: httpUrl("OPENAI_COMPATIBLE_BASE_URL"),
    onChange: localProvidersHook,
  },
];

/**
 * Add one managed entry per direct-provider env var. A variable already
 * managed (GEMINI_API_KEY via `gemini`; MOONSHOT_API_KEY shared by two
 * Moonshot endpoints; CLOUDFLARE_* shared by both Cloudflare providers) keeps
 * its first id/bodyField and only gains the extra auth-selection hook, so the
 * Settings UI and `/providers` can address every field by env var.
 */
function buildManagedKeys(): ManagedKey[] {
  const keys = [...BASE_MANAGED_KEYS];
  const byEnv = new Map(keys.map((k) => [k.envVar, k] as const));
  const runtimeTargets = new Map<string, string[]>();
  for (const provider of DIRECT_PROVIDERS) {
    if (provider.keyEnvVar) {
      if (!byEnv.has(provider.keyEnvVar)) {
        const entry: ManagedKey = {
          id: provider.id,
          bodyField: providerKeyBodyField(provider.id),
          envVar: provider.keyEnvVar,
          secret: true,
        };
        keys.push(entry);
        byEnv.set(provider.keyEnvVar, entry);
      }
      if (provider.runtimeKey) {
        const targets = runtimeTargets.get(provider.keyEnvVar) ?? [];
        targets.push(provider.id);
        runtimeTargets.set(provider.keyEnvVar, targets);
      }
    }
    for (const field of provider.extraEnv) {
      if (byEnv.has(field.envVar)) continue;
      const entry: ManagedKey = {
        id: field.envVar,
        bodyField: field.envVar,
        envVar: field.envVar,
        secret: field.secret,
      };
      keys.push(entry);
      byEnv.set(field.envVar, entry);
    }
  }
  for (const [envVar, providerIds] of runtimeTargets) {
    const entry = byEnv.get(envVar)!;
    const previous = entry.onChange;
    const push = runtimeKeyHook(providerIds);
    entry.onChange = previous
      ? async (key, runtime) => {
          await previous(key, runtime);
          await push!(key, runtime);
        }
      : push;
  }
  return keys;
}

const MANAGED_KEYS: ManagedKey[] = buildManagedKeys();
const MANAGED_BY_ENV = new Map(MANAGED_KEYS.map((k) => [k.envVar, k] as const));

/** How the Settings UI addresses an env var: its status id and PUT body field. */
export function credentialFieldFor(
  envVar: string,
): { credentialId: string; bodyField: string } | undefined {
  const entry = MANAGED_BY_ENV.get(envVar);
  return entry ? { credentialId: entry.id, bodyField: entry.bodyField } : undefined;
}

const MODAL_ID_FIELD = "modalTokenId";
const MODAL_SECRET_FIELD = "modalTokenSecret";
let modalCredentialValidator = validateModalCredentials;

/** Injectable only so credential route tests never contact Modal. */
export function setModalCredentialValidatorForTests(
  validator: typeof validateModalCredentials | null,
): void {
  modalCredentialValidator = validator ?? validateModalCredentials;
}

/** Redirect persistence in tests so the user's real repo .env is never touched. */
export function setCredentialEnvPathForTests(file: string | null): void {
  credentialEnvPath = file ?? ENV_PATH;
}

function readKey(spec: ManagedKey): string | null {
  for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Show only enough to recognize the key, never enough to use it. */
function mask(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Upsert a KEY=value line in `.env`, preserving other lines and
 *  comments. Creates the file if missing. Values are quoted only when needed. */
function persistEnv(name: string, value: string): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(credentialEnvPath, "utf-8").split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const isAssignment = (l: string, key: string) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    return match?.[1] === key;
  };
  // Drop any existing assignment for this key.
  lines = lines.filter((l) => !isAssignment(l, name));
  // applyKey rejects these first; this is the last line of defence, since a
  // line break here would let a value write its own NODE_OPTIONS= line.
  const invalid = invalidEnvValue(value);
  if (invalid) throw new Error(invalid);
  // env-file.mjs has no escapes: a quoted value ends at its closing quote,
  // so pick the quote character the value does not contain.
  const needsQuote = /[\s#"'\\]/.test(value);
  const rendered = !needsQuote ? value : value.includes('"') ? `'${value}'` : `"${value}"`;
  // Keep a trailing newline tidy: append before any trailing blank lines.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`${name}=${rendered}`);
  fs.mkdirSync(path.dirname(credentialEnvPath), { recursive: true });
  fs.writeFileSync(credentialEnvPath, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing one too.
  try {
    fs.chmodSync(credentialEnvPath, 0o600);
  } catch {
    // Windows ACLs do not map to POSIX modes; nothing to tighten there.
  }
}

function status() {
  const out: Record<string, { set: boolean; masked: string | null }> = {};
  for (const spec of MANAGED_KEYS) {
    const key = readKey(spec);
    // Non-secret configuration (regions, ids, endpoints) is echoed in full so
    // the user can recognize a stale value; only secrets are masked.
    out[spec.id] = key
      ? { set: true, masked: spec.secret === false ? key : mask(key) }
      : { set: false, masked: null };
  }
  return out;
}

/**
 * Why `value` cannot be stored in `.env`, or null. Control characters would
 * start a new assignment (a pasted `"sk-…\nNODE_OPTIONS=--import=…"` runs code
 * on the next launch), and the parser has no escape for a value holding both
 * quote characters.
 */
export function invalidEnvValue(value: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return "That value contains a line break or control character; paste the key on its own.";
  }
  if (value.includes('"') && value.includes("'")) {
    return "That value contains both single and double quotes, which cannot be stored in .env.";
  }
  return null;
}

function validateKey(spec: ManagedKey, raw: unknown): string | null {
  if (raw !== null && typeof raw !== "string") {
    return `${spec.bodyField} must be a string, or null to clear it.`;
  }
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") return null;
  const invalid = invalidEnvValue(key);
  if (invalid) return invalid;
  const malformed = spec.validate?.(key);
  if (malformed) return malformed;
  // Basic sanity check — we don't hard-reject on format (providers change
  // formats), just guard against pasted junk. Configuration values are exempt
  // (`global`, `us-east-1`, a short resource name).
  if (spec.secret !== false && key.length < 8) {
    return "That key looks too short to be valid.";
  }
  return null;
}

async function applyKey(spec: ManagedKey, raw: string | null, runtime: ModelRuntime): Promise<string | null> {
  const invalid = validateKey(spec, raw);
  if (invalid) return invalid;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") {
    // Empty assignments also shadow stale shell/legacy/server .env values
    // on restart; removing the line would silently resurrect those keys.
    for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) {
      persistEnv(name, "");
      delete process.env[name];
    }
    await spec.onChange?.(null, runtime);
    return null;
  }
  persistEnv(spec.envVar, key);
  process.env[spec.envVar] = key;
  await spec.onChange?.(key, runtime);
  return null;
}

export async function registerCredentialRoutes(
  app: FastifyInstance,
  options: { runtime?: ModelRuntime } = {},
): Promise<void> {
  const runtime = options.runtime ?? getModelRuntime();
  app.get("/credentials", async () => status());

  app.put<{ Body: Record<string, string | null | undefined> }>(
    "/credentials",
    async (req, reply) => {
      const provided = MANAGED_KEYS.filter((s) => req.body?.[s.bodyField] !== undefined);
      if (provided.length === 0) {
        reply.code(400);
        const fields = MANAGED_KEYS.map((s) => s.bodyField).join(", ");
        return { detail: `Provide at least one of: ${fields} (a string, or null to clear)` };
      }
      // Validate everything before changing anything, so one bad field does
      // not leave the others half-applied.
      for (const spec of provided) {
        const error = validateKey(spec, req.body?.[spec.bodyField] ?? null);
        if (error) {
          reply.code(400);
          return { detail: error };
        }
      }

      // Modal is one logical credential represented by two variables. Build
      // and validate the candidate pair before changing process.env or .env,
      // preventing a valid existing pair from being half-overwritten.
      const changesModal =
        req.body?.[MODAL_ID_FIELD] !== undefined ||
        req.body?.[MODAL_SECRET_FIELD] !== undefined;
      if (changesModal) {
        const modalIdSpec = MANAGED_KEYS.find((spec) => spec.bodyField === MODAL_ID_FIELD)!;
        const modalSecretSpec = MANAGED_KEYS.find((spec) => spec.bodyField === MODAL_SECRET_FIELD)!;
        const candidate = (field: string, current: string | null) => {
          const raw = req.body?.[field];
          if (raw === undefined) return current;
          return typeof raw === "string" && raw.trim() ? raw.trim() : null;
        };
        const tokenId = candidate(MODAL_ID_FIELD, readKey(modalIdSpec));
        const tokenSecret = candidate(MODAL_SECRET_FIELD, readKey(modalSecretSpec));
        if (Boolean(tokenId) !== Boolean(tokenSecret)) {
          reply.code(400);
          return {
            detail:
              "Modal credentials are a pair: provide both modalTokenId and modalTokenSecret, or clear both.",
          };
        }
        if (tokenId && tokenSecret) {
          if (tokenId.length < 8 || tokenSecret.length < 8) {
            reply.code(400);
            return { detail: "One or both Modal credential values look too short to be valid." };
          }
          try {
            await modalCredentialValidator(tokenId, tokenSecret);
          } catch (error) {
            reply.code(400);
            return {
              detail: `Modal credentials could not be validated: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }
      }
      for (const spec of provided) {
        const error = await applyKey(spec, req.body?.[spec.bodyField] ?? null, runtime);
        if (error) {
          reply.code(400);
          return { detail: error };
        }
      }
      if (
        changesModal &&
        process.env.MODAL_TOKEN_ID &&
        process.env.MODAL_TOKEN_SECRET
      ) {
        // Jobs whose restart recovery was deferred while credentials were
        // absent can reattach immediately; no server restart or cold session
        // rebuild is required.
        await modalJobManager.recoverAllProjects();
        await notebookRobustness.recoverAll();
      }
      return status();
    },
  );
}
