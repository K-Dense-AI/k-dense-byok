/**
 * Bounded sandbox snapshot + diff.
 *
 * `write`/`edit` name the file they touch, so those edges need no scan. `bash`
 * does not: `python de_analysis.py` is how most real scientific outputs get
 * created, and the only way to see it is to compare the sandbox before and
 * after. This module is that comparison.
 *
 * Two properties matter more than completeness:
 *   - It must not dominate the run. The walk is stat-only; hashing happens
 *     later and only for files that actually moved.
 *   - It must degrade visibly. Past the file budget we stop and say so
 *     (`sandbox-too-large`) rather than silently reporting "nothing changed",
 *     which would read as a verified absence of outputs.
 */
import fs from "node:fs";
import path from "node:path";
import { apiRelative, isUserVisible } from "../sandbox-fs.ts";
import type { DegradeReason } from "./store.ts";

/** Stat-only walks are cheap, but a sandbox holding an unpacked reference
 *  genome is not. Past this many files we degrade instead of crawling. */
export const MAX_SCAN_FILES = 20_000;

/** Directory names skipped wholesale. Any dot-directory is excluded by rule
 *  (matching isUserVisible), which covers .kady/.pi/.git/.venv; these are the
 *  non-dot heavyweights that carry no user-authored artifacts. */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "site-packages"]);

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Sandbox-relative wire path -> cheap identity. */
export type Snapshot = Map<string, FileStat>;

export interface ScanResult {
  snapshot: Snapshot;
  /** Set when the snapshot is incomplete and must not be read as authoritative. */
  degraded?: DegradeReason;
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

/**
 * Stat every user-visible regular file under the sandbox.
 *
 * Async so the run loop's event handler never blocks on it: a stalled handler
 * stalls SSE for every concurrent tab in the project, and this walk runs once
 * per mutating tool call.
 */
export async function scanSandbox(
  sandboxRoot: string,
  maxFiles: number = MAX_SCAN_FILES,
): Promise<ScanResult> {
  const snapshot: Snapshot = new Map();
  const queue: string[] = [sandboxRoot];
  let count = 0;

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      // A directory removed mid-walk is normal; anything else means the
      // snapshot is untrustworthy and callers must not diff against it.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { snapshot, degraded: "scan-failed" };
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) queue.push(abs);
        continue;
      }
      // Symlinks are deliberately not followed: a link pointing outside the
      // sandbox is not an artifact of this project, and following one invites
      // both cycles and escapes.
      if (!entry.isFile()) continue;
      if (!isUserVisible(abs, sandboxRoot)) continue;
      if (count >= maxFiles) return { snapshot, degraded: "sandbox-too-large" };
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(abs);
      } catch {
        continue; // vanished between readdir and stat
      }
      snapshot.set(apiRelative(sandboxRoot, abs), {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      count++;
    }
  }
  return { snapshot };
}

export interface SnapshotDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Compare two snapshots.
 *
 * Change detection is size-or-mtime, not content: a rewrite that preserves both
 * is invisible here. That is the standard build-system tradeoff, and the
 * recorder hashes every changed file afterward so the *identity* of what we do
 * report is exact even though the *detection* is heuristic.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [rel, now] of after) {
    const then = before.get(rel);
    if (!then) created.push(rel);
    else if (then.size !== now.size || then.mtimeMs !== now.mtimeMs) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) deleted.push(rel);
  }
  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}
