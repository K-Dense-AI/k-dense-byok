/**
 * Wiring so SUBAGENTS contribute to the lab notebook (Phase 5).
 *
 *  1. seedNotebookPackage — reference the vendored kady-notebook package from
 *     sandbox/.pi/settings.json "packages" so child pi processes load it and
 *     get the `notebook` tool. Mirrors seedWebAccessPackage. Sandbox trust is
 *     already established by ensureWebAccess (called in the same build()), so
 *     no separate trust write is needed here.
 *  2. makeSubagentNotebookExtension — on subagent completion (sync tool_result
 *     + async subagent:async-complete, same events the cost ledger uses), parse
 *     each child's session file for `notebook` tool-calls and append them to
 *     the PARENT notebook. The parent is the single writer.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";
import { notebookEntriesFromSessionFile } from "./notebook-harvest.ts";

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
        if (harvestedIds.has(entry.id)) continue;
        harvestedIds.add(entry.id);
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
