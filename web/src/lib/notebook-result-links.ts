/** References to canonical persisted scientific_result tool results, never copied measurements. */
import type { ScientificResultCard } from "./scientific-results";
export interface NotebookResultLink {
  toolCallId: string;
  sessionId?: string;
  /** Server-only harvest marker. Never accepted from model tool arguments. */
  childLocal?: true;
}
export interface NotebookResultSnapshot extends NotebookResultLink {
  sessionId: string;
  sha256?: string;
  status: "available" | "missing" | "unverified" | "ambiguous";
  reason?: string;
}
export interface NotebookResolvedResult<Card = ScientificResultCard> {
  reference: NotebookResultSnapshot;
  status: NotebookResultSnapshot["status"] | "changed";
  card?: Card;
  sha256?: string;
  reason?: string;
}
export function normalizeResultLinks(input: unknown, allowChildLocal = false): NotebookResultLink[] {
  if (!Array.isArray(input)) return [];
  const unique = new Map<string, NotebookResultLink>();
  for (const value of input.slice(0, 12)) {
    if (!value || typeof value !== "object" || typeof value.toolCallId !== "string" || !value.toolCallId.trim() || value.toolCallId.length > 500) continue;
    if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.sessionId))) continue;
    const ref: NotebookResultLink = { toolCallId: value.toolCallId.trim(), ...(value.sessionId ? { sessionId: value.sessionId as string } : {}), ...(allowChildLocal && value.childLocal === true ? { childLocal: true as const } : {}) };
    unique.set(JSON.stringify(ref), ref);
  }
  return [...unique.values()];
}
export function resultReferenceText(ref: NotebookResultSnapshot | NotebookResultLink, sessionId?: string): string {
  const snapshot = ref as NotebookResultSnapshot;
  if (ref.childLocal) return `child-local/${ref.toolCallId} · source not indexed; unverified`;
  return `${ref.sessionId ?? sessionId ?? "this chat"}/${ref.toolCallId}${snapshot.sha256 ? ` · sha256 ${snapshot.sha256}` : " · identity not pinned"}`;
}
