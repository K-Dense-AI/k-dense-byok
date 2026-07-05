/**
 * Lab-notebook entry model + pure helpers shared by useAgent and the view.
 *
 * A live `tool_start` frame (toolName "notebook") carries only the model-
 * supplied fields — parseNotebookFrame builds a *provisional* entry from it
 * (client timestamp). The authoritative entry (server timestamp + role) comes
 * from GET /sessions/:id/notebook; mergeNotebookEntries reconciles the two by id.
 */
import type { AgentFrame } from "./use-agent";

export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

export interface NotebookEntry {
  id: string;
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: { source: string; lang?: string };
  confidence?: "low" | "medium" | "high";
  tags?: string[];
  timestamp: number;
  role?: string;
}

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

export function parseNotebookFrame(frame: AgentFrame): NotebookEntry | null {
  if (frame.type !== "tool_start" || frame.toolName !== "notebook") return null;
  const a = frame.args as Record<string, unknown> | undefined;
  if (!a || !isEntryType(a.type)) return null;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) return null;
  return {
    id: String(frame.toolCallId ?? title),
    type: a.type,
    title,
    body: typeof a.body === "string" ? a.body : undefined,
    artifacts: Array.isArray(a.artifacts) ? a.artifacts.map(String) : undefined,
    code:
      a.code && typeof (a.code as { source?: unknown }).source === "string"
        ? {
            source: String((a.code as { source: string }).source),
            lang: typeof (a.code as { lang?: unknown }).lang === "string"
              ? String((a.code as { lang: string }).lang)
              : undefined,
          }
        : undefined,
    confidence:
      a.confidence === "low" || a.confidence === "medium" || a.confidence === "high"
        ? a.confidence
        : undefined,
    tags: Array.isArray(a.tags) ? a.tags.map(String) : undefined,
    timestamp: Date.now(),
  };
}

export function mergeNotebookEntries(
  a: NotebookEntry[],
  b: NotebookEntry[],
): NotebookEntry[] {
  const byId = new Map<string, NotebookEntry>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e); // b (authoritative) wins on conflict
  return [...byId.values()].sort((x, y) => x.timestamp - y.timestamp);
}
