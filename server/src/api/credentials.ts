/**
 * Runtime credential management for the bring-your-own-key model.
 *
 * Historically the only way to set a key was to edit the repo-root `.env` and
 * restart the app — a real wall for a non-technical scientist. These endpoints
 * let the Settings UI read key status and set the OpenRouter key live:
 *   - GET  /credentials  → masked status (never the raw key)
 *   - PUT  /credentials  → set/clear the key, persist to `.env`, and push it
 *                          into the shared AuthStorage so in-flight sessions
 *                          pick it up without a restart.
 *
 * The key is stored exactly where the app already expects it (repo-root
 * `.env`, plaintext, on the user's own machine) — we are removing friction,
 * not changing the trust model. The server binds to localhost only.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "../config.ts";
import { getAuthStorage } from "../agent/session-registry.ts";

const ENV_PATH = path.join(REPO_ROOT, ".env");
const OPENROUTER_VARS = ["OPENROUTER_API_KEY", "OR_API_KEY"] as const;

function readKey(): { value: string; source: "env" } | null {
  for (const name of OPENROUTER_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return { value: v.trim(), source: "env" };
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
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
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
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

function status() {
  const key = readKey();
  return {
    openrouter: key
      ? { set: true as const, masked: mask(key.value) }
      : { set: false as const, masked: null },
  };
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/credentials", async () => status());

  app.put<{ Body: { openrouterApiKey?: string | null } }>(
    "/credentials",
    async (req, reply) => {
      const raw = req.body?.openrouterApiKey;
      if (raw === undefined) {
        reply.code(400);
        return { detail: "Provide openrouterApiKey (a string, or null to clear)" };
      }
      const key = typeof raw === "string" ? raw.trim() : "";
      if (key === "") {
        // Clear: drop from process.env, .env, and AuthStorage.
        for (const name of OPENROUTER_VARS) delete process.env[name];
        persistEnv("OPENROUTER_API_KEY", null);
        try {
          getAuthStorage().setRuntimeApiKey("openrouter", "");
        } catch {
          /* AuthStorage may reject empty; status still reflects the cleared env */
        }
        return status();
      }
      // Basic sanity check — OpenRouter keys look like `sk-or-...`. We don't
      // hard-reject (providers change formats), just guard against pasted junk.
      if (key.length < 8) {
        reply.code(400);
        return { detail: "That key looks too short to be valid." };
      }
      process.env.OPENROUTER_API_KEY = key;
      persistEnv("OPENROUTER_API_KEY", key);
      getAuthStorage().setRuntimeApiKey("openrouter", key);
      return status();
    },
  );
}
