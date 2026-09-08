/**
 * pi-subagents runtime settings Kady seeds into `sandbox/.pi/settings.json`.
 *
 * Both entries are write-if-missing: a key the user (or the Settings UI) has
 * already set is never touched, so this only fills in Kady's defaults for a
 * project that has none.
 *
 *  1. `subagents.forceTopLevelAsync = true`. Since pi-subagents 0.65 children
 *     are native Pi sessions: a background child runs in a detached runner
 *     process that loads the sandbox's ambient packages, a *foreground* child
 *     (`async: false`) runs inside the parent process and — by design — loads
 *     none of them. Every tool Kady gives a child arrives as an ambient package
 *     (kady-notebook, kady-modal, kady-pdf-annotations, pi-web-access, MCP), so
 *     a foreground child would silently lose all of them. Forcing background
 *     execution keeps the pre-0.65 capability set for every launch; the lead
 *     already blocks on children with `bg_wait`.
 *
 *  2. `subagents.agentOverrides.<name>.disabled = true` for the builtin
 *     specialists that drive an *external* coding CLI (`runner.type:
 *     external-cli` — Claude Code, Codex, Cursor Agent; pi-subagents ≥0.57).
 *     They need that CLI installed and authenticated on the host and run
 *     entirely outside Kady's model runtime, cost ledger and spend cap. Off by
 *     default; the Specialists tab can enable any of them, and that choice
 *     sticks because the key then exists.
 */
import fs from "node:fs";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";
import { isExternalCliAgent, listBuiltinAgents } from "./agent-files.ts";
import type { ProjectPaths } from "../projects.ts";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

/** Returns true when the settings file was written. */
export function seedSubagentRuntimeSettings(paths: ProjectPaths): boolean {
  // Parsed here rather than via readPiSettings(): that helper maps a malformed
  // file to `{}`, and rewriting from that would destroy user configuration.
  // Missing is fine (start empty); unparseable means leave it alone.
  let settings: Rec = {};
  try {
    settings = asRecord(JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8")));
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const subagents = { ...asRecord(settings.subagents) };
  let changed = false;

  if (!("forceTopLevelAsync" in subagents)) {
    subagents.forceTopLevelAsync = true;
    changed = true;
  }

  const overrides = { ...asRecord(subagents.agentOverrides) };
  for (const agent of listBuiltinAgents()) {
    if (!isExternalCliAgent(agent)) continue;
    const existing = overrides[agent.name];
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      continue; // malformed user entry — leave it alone
    }
    const override = asRecord(existing);
    if ("disabled" in override) continue;
    overrides[agent.name] = { ...override, disabled: true };
    changed = true;
  }
  if (changed) subagents.agentOverrides = overrides;

  if (!changed) return false;
  settings.subagents = subagents;
  writePiSettings(paths, settings);
  return true;
}
