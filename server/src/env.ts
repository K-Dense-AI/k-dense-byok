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
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "../../env-file.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Later files do not override earlier ones (existing env always wins), so
// order is just discovery preference.
applyEnvFile(path.join(repoRoot, ".env"));
applyEnvFile(path.join(repoRoot, "kady_agent", ".env"));
applyEnvFile(path.join(repoRoot, "server", ".env"));
