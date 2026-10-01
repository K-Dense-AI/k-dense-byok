/**
 * Integration glue for the `pi-web-access` package (npm:pi-web-access).
 *
 * The package is a Pi extension that registers web tools — `web_search`,
 * `fetch_content`, `get_search_content`, `source_check` — covering search
 * (Exa / Perplexity / Gemini), URL/PDF extraction, GitHub repo cloning, and
 * YouTube/video understanding. It works without any API key (Exa MCP
 * fallback); EXA_API_KEY / PERPLEXITY_API_KEY / GEMINI_API_KEY unlock the
 * direct providers and are managed live via the credentials API.
 *
 * Unlike pi-subagents (loaded in-process through additionalExtensionPaths),
 * web access must also reach the child sessions pi-subagents runs (≥0.65:
 * native Pi sessions inside its detached runner process), so the roster
 * sub-agents can search too. Children discover resources the normal Pi way —
 * project settings in the sandbox — so we:
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
 *  3. default `toolActivation` to "eager" (and seed scientific
 *     `summaryInstructions`) in `<agentDir>/web-search.json`.
 *     Since 0.31 fresh sessions get a `web_enable` loader in place of the web
 *     tools. The lead's tool allowlist filters the loader out, which already
 *     keeps its tools eager, but seeded specialists carry no `tools:` list, so
 *     a headless child would spend its first turn enabling web access.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ProjectTrustStore, getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicJson } from "../atomic-json.ts";
import type { ProjectPaths } from "../projects.ts";

const require_ = createRequire(import.meta.url);

/** Tool names registered by the pi-web-access extension. (`code_search` was
 *  removed upstream in 0.11 — `web_search`'s Exa provider covers it;
 *  `source_check` — claim verification with passage-level citations — was
 *  added in 0.25 and is in the builtin `researcher`'s allowlist.) */
export const WEB_ACCESS_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
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
 * Pre-trust the sandbox so child sessions load its project resources.
 * No-op when a decision (either way) is already recorded.
 */
export function trustSandbox(paths: ProjectPaths, agentDir: string = getAgentDir()): void {
  const store = new ProjectTrustStore(agentDir);
  if (store.get(paths.sandbox) === null) store.set(paths.sandbox, true);
}

/**
 * Requirements appended to pi-web-access's summary prompt (`summaryInstructions`,
 * 0.35+; used by the `auto-summary` and curator workflows). The package keeps
 * its own guardrails — no invented sources, weak-evidence notes, a Sources
 * section — so these only add what research summaries must not lose.
 */
export const SCIENTIFIC_SUMMARY_INSTRUCTIONS = [
  "- Preserve every number verbatim with its unit and uncertainty: effect sizes, confidence intervals, p-values, sample sizes, doses, concentrations, dates, and software, model or database versions.",
  "- Say what each claim rests on: study design, organism or population, and data source.",
  "- Distinguish peer-reviewed papers, preprints, documentation and news, and flag retractions, corrections or expressions of concern the sources mention.",
  "- Give DOIs, PMIDs or arXiv ids when a source shows them.",
].join("\n");

/**
 * `fetch_content` modes Kady allows. Answer mode runs a model on the page
 * through the registry's raw `complete()`: with no reasoning level (models
 * whose reasoning cannot be disabled reject it, see AGENTS.md "One-shot model
 * calls"), and with its usage discarded, so the spend would never reach the
 * ledger or the project cap. `get_search_content` with `findText` covers most
 * page-question needs without a model call.
 */
export const KADY_FETCH_MODES = ["readable", "raw"] as const;

/**
 * Seed pi-web-access's config, each key write-if-missing so a user's choice
 * wins: `toolActivation: "eager"` (an explicit "dynamic" sticks), the
 * scientific `summaryInstructions` (a blank string keeps the package's
 * default prompt), and `fetch.allowedModes` (an explicit list, or a
 * `fetch.defaultMode` of "answer", is left alone). The file doubles as
 * pi-web-access's credential store, so an unparseable one is left untouched
 * and the rewrite keeps owner-only permissions. Returns true when the file
 * was written.
 */
export function seedWebAccessDefaults(agentDir: string = getAgentDir()): boolean {
  const configPath = path.join(agentDir, "web-search.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    config = parsed as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const defaults: Record<string, unknown> = {
    toolActivation: "eager",
    summaryInstructions: SCIENTIFIC_SUMMARY_INSTRUCTIONS,
  };
  const next: Record<string, unknown> = { ...config };
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (key in config) continue;
    next[key] = value;
    changed = true;
  }
  const fetchConfig = config.fetch;
  if (fetchConfig === undefined || (fetchConfig && typeof fetchConfig === "object" && !Array.isArray(fetchConfig))) {
    const current = (fetchConfig ?? {}) as Record<string, unknown>;
    // The package fails closed when the default mode is not allowed.
    if (!("allowedModes" in current) && current.defaultMode !== "answer") {
      next.fetch = { ...current, allowedModes: [...KADY_FETCH_MODES] };
      changed = true;
    }
  }
  if (!changed) return false;
  atomicJson(configPath, next);
  return true;
}

/** Full per-project wiring; called before each session build (idempotent). */
export function ensureWebAccess(paths: ProjectPaths, agentDir: string = getAgentDir()): void {
  seedWebAccessPackage(paths);
  trustSandbox(paths, agentDir);
  seedWebAccessDefaults(agentDir);
}
