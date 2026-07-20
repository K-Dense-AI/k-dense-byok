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
 * transcription); the optional pi-web-access search providers — Exa,
 * Perplexity, Gemini (web search works without any of the three via the Exa MCP
 * fallback; a key unlocks the direct provider, and Gemini also unlocks
 * YouTube/video understanding); and the Modal remote-compute token pair
 * (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) that enables the `modal_run` tool.
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
import { validateModalCredentials } from "../modal/adapter.ts";
import { modalJobManager } from "../modal/manager.ts";

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
  /** Hook run after set/clear (e.g. push into ModelRuntime). */
  onChange?: (key: string | null) => Promise<void>;
}

const MANAGED_KEYS: ManagedKey[] = [
  {
    id: "openrouter",
    bodyField: "openrouterApiKey",
    envVar: "OPENROUTER_API_KEY",
    envAliases: ["OR_API_KEY"],
    onChange: async (key) => {
      try {
        if (key) await getModelRuntime().setRuntimeApiKey("openrouter", key);
        else await getModelRuntime().removeRuntimeApiKey("openrouter");
      } catch {
        /* Runtime refresh failure does not undo the persisted environment change. */
      }
    },
  },
  { id: "exa", bodyField: "exaApiKey", envVar: "EXA_API_KEY" },
  { id: "perplexity", bodyField: "perplexityApiKey", envVar: "PERPLEXITY_API_KEY" },
  { id: "gemini", bodyField: "geminiApiKey", envVar: "GEMINI_API_KEY" },
  // Modal remote compute is two env vars for one logical credential; both must
  // be set for modalConfigured() to flip true and the modal_run tool to register.
  { id: "modalTokenId", bodyField: "modalTokenId", envVar: "MODAL_TOKEN_ID" },
  { id: "modalTokenSecret", bodyField: "modalTokenSecret", envVar: "MODAL_TOKEN_SECRET" },
];

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
  fs.writeFileSync(credentialEnvPath, lines.join("\n") + "\n", "utf-8");
}

function status() {
  const out: Record<string, { set: boolean; masked: string | null }> = {};
  for (const spec of MANAGED_KEYS) {
    const key = readKey(spec);
    out[spec.id] = key ? { set: true, masked: mask(key) } : { set: false, masked: null };
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
  // formats), just guard against pasted junk.
  if (key.length < 8) {
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
      }
      return status();
    },
  );
}
