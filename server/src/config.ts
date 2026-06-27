/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root = parent of `server/`. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Root that holds every project directory. Overridable for tests. */
export const PROJECTS_ROOT = path.resolve(
  process.env.KADY_PROJECTS_ROOT
    ? process.env.KADY_PROJECTS_ROOT
    : path.join(REPO_ROOT, "projects"),
);

function resolveConfigPath(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/**
 * Kady-owned Pi runtime config directory.
 *
 * The embedded parent session and child `pi` CLI subagents should not inherit
 * the user's normal ~/.pi/agent settings, packages, custom models, trust store,
 * or auth files. Keeping this under PROJECTS_ROOT also makes tests and alternate
 * project roots self-contained.
 */
export const KADY_PI_AGENT_DIR = resolveConfigPath(
  process.env.KADY_PI_AGENT_DIR ?? path.join(PROJECTS_ROOT, ".kady", "pi-agent"),
);

export const DEFAULT_PROJECT_ID = "default";

/** HTTP port for the backend (matches the old ADK server). */
export const PORT = Number(process.env.KADY_PORT ?? process.env.PORT ?? 8000);
export const HOST = process.env.KADY_HOST ?? "127.0.0.1";

/** Default orchestrator model, routed through Pi's OpenRouter provider. */
export const DEFAULT_MODEL_PROVIDER =
  process.env.DEFAULT_MODEL_PROVIDER ?? "openrouter";
export const DEFAULT_MODEL_ID =
  process.env.DEFAULT_MODEL_ID ?? "anthropic/claude-opus-4.8";

export type ModelAccessMode = "all" | "free-local";

function normalizeModelAccessMode(raw: string | undefined): ModelAccessMode {
  const value = raw?.trim().toLowerCase() || "free-local";
  if (value === "all") {
    return "all";
  }
  if (value === "free-local" || value === "free_local" || value === "free") {
    return "free-local";
  }
  return "free-local";
}

/**
 * Optional product guardrail for cost-controlled installs. In `free-local`
 * mode Kady exposes and accepts only zero-priced OpenRouter catalogue models
 * plus local providers such as Ollama. This is the default; set
 * `KADY_MODEL_ACCESS_MODE=all` to opt back into paid OpenRouter models.
 */
export const KADY_MODEL_ACCESS_MODE = normalizeModelAccessMode(
  process.env.KADY_MODEL_ACCESS_MODE,
);

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** Whether Modal-style remote compute is configured (kept for /config parity). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}
