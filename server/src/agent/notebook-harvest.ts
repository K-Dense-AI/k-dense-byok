/**
 * Harvest lab-notebook entries a SUBAGENT logged, out of its session JSONL.
 *
 * A child `pi` process gets the `notebook` tool from the kady-notebook package;
 * every call it makes is recorded as an assistant `toolCall` content block in
 * the child's session file. The parent (which learns each child's sessionFile
 * on completion — exactly as usageFromSessionFile harvests cost) parses those
 * calls into NotebookEntry rows, stamped with the child's agent name as `role`
 * and a namespaced id so they never collide with the lead's entries.
 *
 * Pure + defensive: unreadable file / malformed row / invalid entry are skipped.
 */
import fs from "node:fs";
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

/** Coerce a recorded tool-call `arguments` object into a NotebookEntry, or null. */
function entryFromArgs(
  args: Record<string, unknown>,
  id: string,
  role: string,
  timestamp: number,
): NotebookEntry | null {
  if (!isEntryType(args.type)) return null;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  const code =
    args.code && typeof (args.code as { source?: unknown }).source === "string"
      ? {
          source: String((args.code as { source: string }).source),
          lang:
            typeof (args.code as { lang?: unknown }).lang === "string"
              ? String((args.code as { lang: string }).lang)
              : undefined,
        }
      : undefined;
  return {
    id,
    role,
    timestamp,
    type: args.type,
    title,
    body: typeof args.body === "string" ? args.body : undefined,
    artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
    code,
    confidence:
      args.confidence === "low" || args.confidence === "medium" || args.confidence === "high"
        ? args.confidence
        : undefined,
    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
  };
}

export function notebookEntriesFromSessionFile(
  sessionFile: string,
  agentName: string,
): NotebookEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const out: NotebookEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    const timestamp = Number.isNaN(ts) ? Date.now() : ts;
    for (const block of msg.content as unknown[]) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "toolCall" ||
        (block as { name?: unknown }).name !== "notebook"
      ) {
        continue;
      }
      const b = block as { id?: unknown; arguments?: unknown };
      const callId = typeof b.id === "string" ? b.id : "";
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      const entry = entryFromArgs(args, `${agentName}:${callId}`, agentName, timestamp);
      if (entry) out.push(entry);
    }
  }
  return out;
}
