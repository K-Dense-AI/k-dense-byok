/**
 * Pure helpers for the per-tab "run after" queue. Kept out of chat-tab.tsx so
 * ordering and edit semantics are unit-testable without rendering the composer.
 */
import { splitComposerContext } from "./composer-context";

export type QueueDirection = "up" | "down";

/** Swap `id` with its neighbour; returns the same array when nothing moves. */
export function moveQueuedMessage<T extends { id: string }>(
  queue: readonly T[],
  id: string,
  direction: QueueDirection,
): T[] {
  const from = queue.findIndex((item) => item.id === id);
  if (from === -1) return queue as T[];
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= queue.length) return queue as T[];
  const next = [...queue];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * Replace a queued message's text. `rawText` is the one-line preview the
 * queue shows, so it follows the first line of the new text. Empty edits and
 * unknown ids leave the queue untouched (same array identity).
 */
export function updateQueuedMessageText<T extends { id: string; text: string; rawText: string }>(
  queue: readonly T[],
  id: string,
  text: string,
): T[] {
  const trimmed = text.trim();
  if (!trimmed) return queue as T[];
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return queue as T[];
  const current = queue[index];
  if (current.text === trimmed) return queue as T[];
  const next = [...queue];
  next[index] = { ...current, text: trimmed, rawText: trimmed.split("\n")[0] };
  return next;
}

/**
 * Split a queued message into what the user typed and what the composer
 * appended when it was queued: file paths, data sources and skills
 * (`appended`, rebuilt by the caller from the item's own lists) followed by
 * the + menu block. The queue editor edits only the typed part and saving
 * re-attaches the rest unchanged. When `appended` no longer matches the text
 * it stays in the editable part rather than being guessed at.
 */
export function splitQueuedText(text: string, appended: string): { editable: string; suffix: string } {
  const { text: beforeBlock } = splitComposerContext(text);
  const block = text.slice(beforeBlock.length);
  if (appended && beforeBlock.endsWith(appended)) {
    return { editable: beforeBlock.slice(0, -appended.length).trim(), suffix: appended + block };
  }
  // A files-only message: sending trimmed the leading newline off the paths.
  if (appended && beforeBlock === appended.trimStart()) {
    return { editable: "", suffix: beforeBlock + block };
  }
  return { editable: beforeBlock.trim(), suffix: block };
}
