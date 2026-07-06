/**
 * Shared .env parser used by BOTH the launcher (start.mjs) and the backend
 * (server/src/env.ts). Plain ESM with no dependencies so it can run before
 * npm install. Mirrors the parts of bash `source` semantics that .env files
 * relied on under the old start.sh: `export KEY=value` prefixes and unquoted
 * trailing `# comments` are handled.
 *
 * `override` controls precedence: the launcher passes true so .env beats any
 * stale ambient shell export (matching the old `set -a; source .env`); the
 * backend passes false so values inherited from the launcher (or set by the
 * user) win over a re-read of the file.
 */
import fs from "node:fs";

/** Load KEY=VALUE pairs from `file` into process.env. Returns false if the
 *  file can't be read. */
export function applyEnvFile(file, { override = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return false;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted) {
      value = quoted[1] ?? quoted[2];
    } else {
      // Unquoted values end at a whitespace-preceded '#', like in bash.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    if (key && (override || process.env[key] === undefined)) process.env[key] = value;
  }
  return true;
}
