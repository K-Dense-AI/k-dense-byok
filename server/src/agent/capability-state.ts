/**
 * Shared plumbing for the capability hub's enable/disable operations.
 *
 * `ToggleResult` is the uniform return type for relocation helpers so route
 * handlers can map it to an HTTP status without string-matching error messages.
 * The pi-settings helpers own read/modify/write of the project's
 * `sandbox/.pi/settings.json` (also read by pi-web-access + pi-subagents), so we
 * only ever touch the keys we mean to and preserve everything else.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";

export type ToggleResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; detail: string };

export function piSettingsPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "settings.json");
}

export function readPiSettings(paths: ProjectPaths): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed → empty */
  }
  return {};
}

export function writePiSettings(paths: ProjectPaths, settings: Record<string, unknown>): void {
  const file = piSettingsPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
