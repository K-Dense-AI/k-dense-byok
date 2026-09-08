/**
 * Submit routing for the chat composer. While a run streams, Enter steers
 * the live run (text only, delivered before the next model call) and
 * Alt+Enter queues a Pi follow-up: delivered inside the same run once the
 * agent has no more tool calls or steering messages, images allowed. An
 * image message with plain Enter also becomes a follow-up, since steering is
 * text-only. A steer/follow-up that races the run's end (server 409
 * "not_streaming") falls back behind the client-side queue when one exists,
 * so message order is preserved.
 */
export type SendIntent = "auto" | "queue";
export type SubmitRoute = "send" | "steer" | "followUp";

export function routeSubmit(
  isStreaming: boolean,
  intent: SendIntent,
  hasImages = false,
): SubmitRoute {
  if (!isStreaming) return "send";
  if (intent === "queue" || hasImages) return "followUp";
  return "steer";
}

export function steerNotStreamingFallback(queueLength: number): "queue" | "send" {
  return queueLength > 0 ? "queue" : "send";
}
