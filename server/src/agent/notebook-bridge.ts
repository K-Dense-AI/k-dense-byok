/**
 * Wiring so SUBAGENTS contribute to the lab notebook (Phase 5).
 *
 *  1. seedNotebookPackage — reference the vendored kady-notebook package from
 *     sandbox/.pi/settings.json "packages" so child pi processes load it and
 *     get the `notebook` tool. Mirrors seedWebAccessPackage. Sandbox trust is
 *     already established by ensureWebAccess (called in the same build()), so
 *     no separate trust write is needed here.
 *  2. seedBuiltinAgentNotebookTools — pi-subagents' builtin specialists pin a
 *     `tools:` allowlist that pi also applies to package tools, which would
 *     silently strip `notebook` from their children; seed settings.json
 *     agentOverrides adding `notebook` to each builtin's declared list.
 *  3. makeSubagentNotebookExtension — on subagent completion (sync tool_result
 *     + async subagent:async-complete, same events the cost ledger uses), parse
 *     each child's session file for `notebook` tool-calls and append them to
 *     the PARENT notebook. The parent is the single writer.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { appendNotebookEntry } from "./notebook-store.ts";
import { notebookEntriesFromSessionFile } from "./notebook-harvest.ts";

const require_ = createRequire(import.meta.url);

/** Absolute dir of the vendored kady-notebook package. */
export function kadyNotebookPackageDir(): string {
  // server/src/agent/notebook-bridge.ts → server/pi-packages/kady-notebook
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "kady-notebook");
}

/** True when `entry` points at our kady-notebook package dir. */
function isNotebookSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]kady-notebook$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

/**
 * Reference kady-notebook from the project settings file. Returns true when the
 * file was written. A settings file we cannot parse is left untouched.
 */
export function seedNotebookPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pkgDir = kadyNotebookPackageDir();
  const packages = Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
  const kept = packages.filter((p) => !isNotebookSource(p) || p === pkgDir);
  if (kept.includes(pkgDir) && kept.length === packages.length) return false;
  if (!kept.includes(pkgDir)) kept.push(pkgDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

/** Dir of pi-subagents' builtin agent definitions (agents/*.md), if installed. */
function builtinAgentsDir(): string | null {
  try {
    const pkgJson = require_.resolve("pi-subagents/package.json");
    return path.join(path.dirname(pkgJson), "agents");
  } catch {
    return null;
  }
}

/** Minimal frontmatter read: `name:` and comma-separated `tools:` lines. */
function parseAgentFrontmatter(file: string): { name?: string; tools?: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const out: { name?: string; tools?: string[] } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) out.name = name[1];
    const tools = /^tools:\s*(.+?)\s*$/.exec(line);
    if (tools) {
      out.tools = tools[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/**
 * Make the `notebook` tool reachable from pi-subagents' BUILTIN specialists.
 *
 * Builtin agents (researcher, scout, worker, ...) pin a `tools:` allowlist in
 * their frontmatter, and pi applies `--tools` to extension/package tools too —
 * so those children load kady-notebook but the tool is filtered out and their
 * lanes never populate. Project agents we seed declare no allowlist and are
 * unaffected. For every builtin that pins tools without `notebook`, seed a
 * `subagents.agentOverrides.<name>.tools` entry (declared list + "notebook")
 * in sandbox settings.json. An override that already has ANY `tools` value is
 * left untouched (user edits win). Returns true when the file was written.
 */
export function seedBuiltinAgentNotebookTools(paths: ProjectPaths): boolean {
  const agentsDir = builtinAgentsDir();
  if (!agentsDir) return false;
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const subagents =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
      ? (settings.subagents as Record<string, unknown>)
      : {};
  const overrides =
    subagents.agentOverrides &&
    typeof subagents.agentOverrides === "object" &&
    !Array.isArray(subagents.agentOverrides)
      ? (subagents.agentOverrides as Record<string, unknown>)
      : {};

  let changed = false;
  for (const file of files) {
    const { name, tools } = parseAgentFrontmatter(path.join(agentsDir, file));
    if (!name || !tools?.length || tools.includes("notebook")) continue;
    const existing = overrides[name];
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      continue; // malformed user entry — leave it alone
    }
    const override = (existing ?? {}) as Record<string, unknown>;
    if ("tools" in override) continue; // user already pinned tools for this agent
    overrides[name] = { ...override, tools: [...tools, "notebook"] };
    changed = true;
  }
  if (!changed) return false;
  subagents.agentOverrides = overrides;
  settings.subagents = subagents;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

// Namespaced entry ids already harvested, so a re-delivered async completion
// (delivered to every live session's listener) can't double-append. Module-level
// with a size cap, mirroring subagent-bridge's ledgeredAsyncRuns.
const harvestedIds = new Set<string>();

/** Result shape we consume from both the sync and async completion payloads. */
interface ChildResult {
  agent?: string;
  sessionFile?: string;
}

export function makeSubagentNotebookExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory {
  const harvest = (results: ChildResult[] | undefined) => {
    const parentSession = getSessionId();
    if (!parentSession) return;
    for (const r of results ?? []) {
      if (!r.agent || !r.sessionFile) continue;
      const entries = notebookEntriesFromSessionFile(r.sessionFile, r.agent);
      for (const entry of entries) {
        const dedupKey = `${r.sessionFile}:${entry.id}`;
        if (harvestedIds.has(dedupKey)) continue;
        harvestedIds.add(dedupKey);
        if (harvestedIds.size > 5000) harvestedIds.clear();
        appendNotebookEntry(parentSession, entry, projectId);
      }
    }
  };

  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "subagent") return;
      const details = event.details as { results?: ChildResult[] } | undefined;
      harvest(details?.results);
    });
    pi.events.on("subagent:async-complete", (data: unknown) => {
      const payload = data as { results?: ChildResult[] };
      harvest(payload.results);
    });
  };
}
