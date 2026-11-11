/** Seed the plugin's global config and the project's external-CLI defaults.
 * Existing supported settings win. Remove the obsolete project key that the
 * plugin never read; forceTopLevelAsync belongs in extensions/subagent/config.json.
 */

/**
 * pi-subagents (0.74+) feature groups the Kady host cannot present, removed
 * from the model-facing `subagent` tool: `panes` drives the TUI inspector and
 * project panes, `external-machines` targets Herdr saved machines (remote
 * compute here is Modal). Every request carries the tool declaration, so the
 * unused parameters and their guidance are paid for on every lead turn.
 * Fleet controls (status/steer/stop/resume) and schedules are unaffected.
 */
export const KADY_DISABLED_SUBAGENT_FEATURES = ["panes", "external-machines"] as const;
import fs from "node:fs";
import path from "node:path";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import { atomicJson } from "../atomic-json.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";
import { isExternalCliAgent, listBuiltinAgents } from "./agent-files.ts";
import type { ProjectPaths } from "../projects.ts";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

/** Returns true when the settings file was written. */
export function seedSubagentRuntimeSettings(paths: ProjectPaths): boolean {
  // This is a plugin config key, not a Pi settings key. Do not rewrite invalid
  // configuration or override an explicit operator choice.
  const configFile = path.join(KADY_PI_AGENT_DIR, "extensions", "subagent", "config.json");
  let config: Rec = {};
  try {
    const value = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagent config");
    config = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configDefaults: Rec = { forceTopLevelAsync: true, disabledFeatures: [...KADY_DISABLED_SUBAGENT_FEATURES] };
  const missing = Object.entries(configDefaults).filter(([key]) => !(key in config));
  if (missing.length > 0) atomicJson(configFile, { ...config, ...Object.fromEntries(missing) });
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

  if ("forceTopLevelAsync" in subagents) {
    delete subagents.forceTopLevelAsync;
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
