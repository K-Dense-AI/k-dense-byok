/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
import os from "node:os";
import path from "node:path";
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

/** App-scoped Pi configuration/auth directory, established by env.ts. */
const rawPiAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".kady", "pi-agent");
export const KADY_PI_AGENT_DIR = path.resolve(
  rawPiAgentDir === "~"
    ? os.homedir()
    : rawPiAgentDir.startsWith("~/") || rawPiAgentDir.startsWith("~\\")
      ? path.join(os.homedir(), rawPiAgentDir.slice(2))
      : rawPiAgentDir,
);

export const DEFAULT_PROJECT_ID = "default";

/** HTTP port for the backend (matches the old ADK server). */
export const PORT = Number(process.env.KADY_PORT ?? process.env.PORT ?? 8000);
export const HOST = process.env.KADY_HOST ?? "127.0.0.1";

/** Default orchestrator model, routed through Pi's OpenRouter provider. */
export const DEFAULT_MODEL_PROVIDER =
  process.env.DEFAULT_MODEL_PROVIDER ?? "openrouter";
export const DEFAULT_MODEL_ID =
  process.env.DEFAULT_MODEL_ID ?? "anthropic/claude-opus-5";

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Local OpenAI-compatible model server (LM Studio, vLLM, text-generation-webui,
 * …) discovered through the standard `/v1/models` endpoint. Defaults to LM
 * Studio's port so that case needs no configuration; vLLM's default (8000)
 * collides with this backend, so those users must move one of the two.
 */
export const OPENAI_COMPATIBLE_BASE_URL =
  process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || "http://localhost:1234";

/**
 * Whether the user explicitly pointed us at a server. The picker hides the
 * section entirely unless this is true or a server actually answers, so the
 * majority who have never run one never see a dead "not running" row.
 */
export const OPENAI_COMPATIBLE_CONFIGURED = Boolean(
  process.env.OPENAI_COMPATIBLE_BASE_URL?.trim(),
);

/** Whether Modal-style remote compute is configured (kept for /config parity). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}
