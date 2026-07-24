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

export type NotebookStance = "supports" | "refutes" | "neutral";

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
  /** Id of an earlier entry this one responds to (threading). */
  relatesTo?: string;
  /** How this entry bears on relatesTo. */
  stance?: NotebookStance;
  /** Id of an earlier entry this one amends/replaces (append-only history). */
  supersedes?: string;
}

export interface NotebookEntry extends NotebookEntryInput {
  id: string;
  timestamp: number;
  role: string;
  /** Server-stamped id of the /run invocation that produced this entry. */
  runId?: string;
}

/** Session ids become filenames; they arrive raw from URLs. Reject traversal. */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId);
}

export function notebookPath(sessionId: string, projectId?: string): string {
  if (!isValidSessionId(sessionId)) {
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

/**
 * Append only entries whose ids are not already in the session notebook.
 *
 * Harvest re-reads a child's whole session file on every completion and
 * relies on stable namespaced entry ids, so an in-memory guard alone loses
 * its state on restart and re-appends the child's entire history. The parent
 * notebook is the durable record of what has already been harvested.
 *
 * Returns the entries actually written.
 */
export function appendNewNotebookEntries(
  sessionId: string,
  entries: NotebookEntry[],
  projectId?: string,
): NotebookEntry[] {
  if (entries.length === 0) return [];
  const file = notebookPath(sessionId, projectId);
  const seen = new Set(parseNotebookFile(file).map((entry) => entry.id));
  const fresh: NotebookEntry[] = [];
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    fresh.push(entry);
  }
  if (fresh.length === 0) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    fresh.map((entry) => JSON.stringify(entry) + "\n").join(""),
    "utf-8",
  );
  return fresh;
}

function parseNotebookFile(file: string): NotebookEntry[] {
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

export function readNotebookEntries(
  sessionId: string,
  projectId?: string,
): NotebookEntry[] {
  return parseNotebookFile(notebookPath(sessionId, projectId));
}

export interface SessionNotebook {
  sessionId: string;
  entries: NotebookEntry[];
}

/** All per-session notebooks in a project, one array per JSONL file. */
export function readProjectNotebooks(projectId: string): SessionNotebook[] {
  const dir = resolvePaths(projectId).notebookDir;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw exc;
  }
  const out: SessionNotebook[] = [];
  // The .jsonl filter also excludes the <id>.annotations.json sidecars.
  for (const f of files.sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const sessionId = f.slice(0, -".jsonl".length);
    if (!isValidSessionId(sessionId)) continue;
    out.push({ sessionId, entries: parseNotebookFile(path.join(dir, f)) });
  }
  return out;
}
