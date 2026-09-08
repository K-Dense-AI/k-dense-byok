/**
 * Per-project context-compaction settings, stored where Pi reads them:
 * `sandbox/.pi/settings.json` → `compaction.{enabled,reserveTokens,keepRecentTokens}`.
 * Pi deep-merges project settings over the global file and re-reads them at
 * each compaction, so a change applies to live sessions too.
 */
import fs from "node:fs";
import type { ProjectPaths } from "../projects.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";

export interface CompactionSettings {
  enabled: boolean;
  /** Tokens kept free for the model's answer; compaction triggers above `window - reserve`. */
  reserveTokens: number;
  /** Most recent tokens kept verbatim instead of being summarized. */
  keepRecentTokens: number;
}

/** Pi's defaults (settings-manager.js). */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export const COMPACTION_BOUNDS = {
  reserveTokens: { min: 4_000, max: 64_000 },
  keepRecentTokens: { min: 5_000, max: 200_000 },
} as const;

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};

/**
 * Parse the settings file for writing. Missing → `{}`; malformed → `null`,
 * because rewriting from an empty object would destroy the user's file.
 */
function loadForWrite(paths: ProjectPaths): Rec | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8")));
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

export function readCompactionSettings(paths: ProjectPaths): CompactionSettings {
  const settings = loadForWrite(paths) ?? {};
  const compaction = asRecord(settings.compaction);
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    enabled: typeof compaction.enabled === "boolean" ? compaction.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: num(compaction.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    keepRecentTokens: num(compaction.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
  };
}

export type CompactionSettingsPatch = Partial<CompactionSettings>;

/** Validate a patch; returns an error message or null. */
export function validateCompactionPatch(patch: unknown): string | null {
  const body = asRecord(patch);
  if ("enabled" in body && typeof body.enabled !== "boolean") return "enabled must be a boolean";
  for (const key of ["reserveTokens", "keepRecentTokens"] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    const bounds = COMPACTION_BOUNDS[key];
    if (!Number.isInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
      return `${key} must be an integer between ${bounds.min} and ${bounds.max}`;
    }
  }
  return null;
}

/**
 * Merge a validated patch into `compaction`, preserving every other key.
 * Returns the resulting settings, or null when the file is malformed (left
 * untouched — the caller reports 409).
 */
export function writeCompactionSettings(
  paths: ProjectPaths,
  patch: CompactionSettingsPatch,
): CompactionSettings | null {
  const settings = loadForWrite(paths);
  if (settings === null) return null;
  const compaction = { ...asRecord(settings.compaction) };
  if (patch.enabled !== undefined) compaction.enabled = patch.enabled;
  if (patch.reserveTokens !== undefined) compaction.reserveTokens = patch.reserveTokens;
  if (patch.keepRecentTokens !== undefined) compaction.keepRecentTokens = patch.keepRecentTokens;
  writePiSettings(paths, { ...settings, compaction });
  return readCompactionSettings(paths);
}
