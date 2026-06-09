/**
 * Minimal .env loader (no dependency). Imported FIRST in entry points so
 * process.env is populated before config.ts reads it.
 *
 * Looks for a .env in the repo root and the legacy `kady_agent/.env` (so
 * existing users' keys keep working). Existing process.env values win.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// Later files do not override earlier ones (existing env always wins inside
// loadEnvFile), so order is just discovery preference.
loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, "kady_agent", ".env"));
loadEnvFile(path.join(repoRoot, "server", ".env"));
