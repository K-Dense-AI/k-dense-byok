/**
 * Submit routing for the chat composer. While a run streams, Enter steers
 * the live run and Alt+Enter queues a NEW run for afterwards (the queue
 * keeps per-message model/compute selection, which steering cannot).
 * A steer that races the run's end (server 409 "not_streaming") falls back
 * behind the queue when one exists, so message order is preserved.
 */
export type SendIntent = "auto" | "queue";
export type SubmitRoute = "send" | "steer" | "queue";

export function routeSubmit(isStreaming: boolean, intent: SendIntent): SubmitRoute {
  if (!isStreaming) return "send";
  return intent === "queue" ? "queue" : "steer";
}

export function steerNotStreamingFallback(queueLength: number): "queue" | "send" {
  return queueLength > 0 ? "queue" : "send";
}
