/**
 * Minimal .env loader (no dependency). Imported FIRST in entry points so
 * process.env is populated before config.ts reads it.
 *
 * Looks for a .env in the repo root and the legacy `kady_agent/.env` (so
 * existing users' keys keep working). Existing process.env values win —
 * when the app is started via start.mjs the launcher has already loaded
 * .env (with .env-wins precedence, like the old `set -a; source .env`).
 * The parser itself is shared with the launcher: repo-root env-file.mjs.
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "../../env-file.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Later files do not override earlier ones (existing env always wins), so
// order is just discovery preference.
applyEnvFile(path.join(repoRoot, ".env"));
applyEnvFile(path.join(repoRoot, "kady_agent", ".env"));
applyEnvFile(path.join(repoRoot, "server", ".env"));

// Keep Kady's Pi credentials/settings separate from the user's standalone Pi
// CLI by default. The same environment variable is inherited by pi-subagents'
// child processes, so lead and child runs share one file-locked auth.json
// without copying OAuth tokens into process arguments or project files.
//
// An explicitly supplied PI_CODING_AGENT_DIR remains authoritative for users
// who intentionally want Kady and their Pi CLI to share configuration. Resolve
// it once here so child processes launched from a sandbox cwd see the same
// directory even when the configured value was relative.
const configuredPiDir =
  process.env.PI_CODING_AGENT_DIR?.trim() ||
  process.env.KADY_PI_AGENT_DIR?.trim() ||
  path.join(os.homedir(), ".kady", "pi-agent");
const expandedPiDir =
  configuredPiDir === "~"
    ? os.homedir()
    : configuredPiDir.startsWith("~/") || configuredPiDir.startsWith("~\\")
      ? path.join(os.homedir(), configuredPiDir.slice(2))
      : configuredPiDir;
process.env.PI_CODING_AGENT_DIR = path.resolve(repoRoot, expandedPiDir);
