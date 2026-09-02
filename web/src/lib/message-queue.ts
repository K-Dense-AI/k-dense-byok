/**
 * Pure helpers for the per-tab "run after" queue. Kept out of chat-tab.tsx so
 * ordering and edit semantics are unit-testable without rendering the composer.
 */

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
