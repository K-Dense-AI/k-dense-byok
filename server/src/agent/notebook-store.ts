/**
 * Durable per-session lab-notebook store.
 *
 * One JSONL row per entry under sandbox/.kady/notebook/<sessionId>.jsonl —
 * the same layout family as the cost ledger (.kady/runs/.../costs.jsonl).
 * This file is the authoritative source of truth for reload and export;
 * the live SSE `tool_start` frame is only a provisional mirror.
 */
import fs from "node:fs";
import path from "node:path";
import { activePaths, resolvePaths } from "../projects.ts";

export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

export interface NotebookCode {
  source: string;
  lang?: string;
}

export interface NotebookEntryInput {
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: NotebookCode;
  confidence?: "low" | "medium" | "high";
  tags?: string[];
}

export interface NotebookEntry extends NotebookEntryInput {
  id: string;
  timestamp: number;
  role: string;
}

export function notebookPath(sessionId: string, projectId?: string): string {
  // Session id becomes a filename; it arrives raw from the URL. Reject traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.notebookDir, `${sessionId}.jsonl`);
}

export function appendNotebookEntry(
  sessionId: string,
  entry: NotebookEntry,
  projectId?: string,
): void {
  const file = notebookPath(sessionId, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

export function readNotebookEntries(
  sessionId: string,
  projectId?: string,
): NotebookEntry[] {
  const file = notebookPath(sessionId, projectId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw exc;
  }
  const out: NotebookEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NotebookEntry);
    } catch {
      // Skip a truncated/corrupt row rather than failing the whole read.
    }
  }
  return out;
}
