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
 *                          restart. The OpenRouter key is additionally pushed
 *                          into the shared ModelRuntime.
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
 * the `modal_run` tool.
 *
 * Keys are stored exactly where the app already expects them (repo-root
 * `.env`, plaintext, on the user's own machine) — we are removing friction,
 * not changing the trust model. The server binds to localhost only.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "../config.ts";
import { getModelRuntime } from "../agent/session-registry.ts";
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
  /** Hook run after set/clear (e.g. push into ModelRuntime). */
  onChange?: (key: string | null) => Promise<void>;
}

/** Mirror a key into Pi's runtime credential so `checkAuth` flips immediately. */
function runtimeKeyHook(providerIds: readonly string[]): ManagedKey["onChange"] {
  return async (key) => {
    for (const providerId of providerIds) {
      try {
        if (key) await getModelRuntime().setRuntimeApiKey(providerId, key);
        else await getModelRuntime().removeRuntimeApiKey(providerId);
      } catch {
        /* Runtime refresh failure does not undo the persisted environment change. */
      }
    }
  };
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
];

/**
 * Add one managed entry per direct-provider env var. A variable already
 * managed (GEMINI_API_KEY via `gemini`; MOONSHOT_API_KEY shared by two
 * Moonshot endpoints; CLOUDFLARE_* shared by both Cloudflare providers) keeps
 * its first id/bodyField and only gains the extra runtime push, so the
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
      ? async (key) => {
          await previous(key);
          await push!(key);
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

/** Upsert (or remove) a KEY=value line in `.env`, preserving other lines and
 *  comments. Creates the file if missing. Values are quoted only when needed. */
function persistEnv(name: string, value: string | null): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(credentialEnvPath, "utf-8").split("\n");
  } catch {
    lines = [];
  }
  const isAssignment = (l: string, key: string) =>
    l.trim().startsWith(`${key}=`) && !l.trim().startsWith("#");
  // Drop any existing assignment for this key.
  lines = lines.filter((l) => !isAssignment(l, name));
  if (value !== null) {
    const needsQuote = /[\s#"']/.test(value);
    const rendered = needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value;
    // Keep a trailing newline tidy: append before any trailing blank lines.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(`${name}=${rendered}`);
  }
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

async function applyKey(spec: ManagedKey, raw: string | null): Promise<string | null> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") {
    // Clear: drop from process.env and .env.
    for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) delete process.env[name];
    persistEnv(spec.envVar, null);
    await spec.onChange?.(null);
    return null;
  }
  // Basic sanity check — we don't hard-reject on format (providers change
  // formats), just guard against pasted junk. Configuration values are exempt
  // (`global`, `us-east-1`, a short resource name).
  if (spec.secret !== false && key.length < 8) {
    return "That key looks too short to be valid.";
  }
  process.env[spec.envVar] = key;
  persistEnv(spec.envVar, key);
  await spec.onChange?.(key);
  return null;
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
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
        const error = await applyKey(spec, req.body?.[spec.bodyField] ?? null);
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
