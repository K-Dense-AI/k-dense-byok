/**
 * Integration glue for the `pi-web-access` package (npm:pi-web-access).
 *
 * The package is a Pi extension that registers web tools — `web_search`,
 * `code_search`, `fetch_content`, `get_search_content` — covering search
 * (Exa / Perplexity / Gemini), URL/PDF extraction, GitHub repo cloning, and
 * YouTube/video understanding. It works without any API key (Exa MCP
 * fallback); EXA_API_KEY / PERPLEXITY_API_KEY / GEMINI_API_KEY unlock the
 * direct providers and are managed live via the credentials API.
 *
 * Unlike pi-subagents (loaded in-process through additionalExtensionPaths),
 * web access must also reach the child `pi` CLI processes that pi-subagents
 * spawns, so the roster sub-agents can search too. Children discover
 * resources the normal Pi way — project settings in the sandbox — so we:
 *
 *  1. reference the locally installed package from
 *     `sandbox/.pi/settings.json` ("packages"). Local-path package sources
 *     are loaded in place, no npm install. The in-process parent session
 *     picks this up through the same project settings (SDK sessions treat
 *     the project as trusted), so the package is wired exactly once.
 *  2. mark the sandbox as trusted in the Pi trust store
 *     (`<agentDir>/trust.json`). Child CLI runs are non-interactive and
 *     silently skip project resources in untrusted directories. We only
 *     pre-trust sandboxes this app created and seeded; an explicit "false"
 *     a user recorded is never overridden.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ProjectTrustStore, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";

const require_ = createRequire(import.meta.url);

/** Tool names registered by the pi-web-access extension. */
export const WEB_ACCESS_TOOLS = [
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
];

/** Directory of the locally installed pi-web-access package. */
export function webAccessPackageDir(): string {
  return path.dirname(require_.resolve("pi-web-access/package.json"));
}

/** True when `entry` is a package source string pointing at a pi-web-access dir. */
function isWebAccessSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]pi-web-access$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

/**
 * Reference pi-web-access from the project settings file, creating or
 * repairing the "packages" entry as needed. Returns true when the file was
 * written. A settings file we cannot parse is left untouched — overwriting
 * it would destroy user configuration, and the session surfaces the parse
 * error on its own.
 */
export function seedWebAccessPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pkgDir = webAccessPackageDir();
  const packages = Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
  // Drop stale references from a moved repo/node_modules before re-adding.
  const kept = packages.filter((p) => !isWebAccessSource(p) || p === pkgDir);
  if (kept.includes(pkgDir) && kept.length === packages.length) return false;
  if (!kept.includes(pkgDir)) kept.push(pkgDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

/**
 * Pre-trust the sandbox so child `pi` processes load its project resources.
 * No-op when a decision (either way) is already recorded.
 */
export function trustSandbox(paths: ProjectPaths, agentDir: string = getAgentDir()): void {
  const store = new ProjectTrustStore(agentDir);
  if (store.get(paths.sandbox) === null) store.set(paths.sandbox, true);
}

/** Full per-project wiring; called before each session build (idempotent). */
export function ensureWebAccess(paths: ProjectPaths, agentDir: string = getAgentDir()): void {
  seedWebAccessPackage(paths);
  trustSandbox(paths, agentDir);
}
