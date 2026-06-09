/**
 * Map Pi's AgentSessionEvent union onto a stable, compact SSE schema the
 * frontend consumes. We deliberately flatten the streaming deltas and drop
 * Pi-internal lifecycle noise so the client contract stays small.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ClientFrame {
  type: string;
  [k: string]: unknown;
}

function cap(s: unknown, max = 4000): string {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Returns a client frame for an event, or null to skip it. */
export function toClientFrame(ev: AgentSessionEvent): ClientFrame | null {
  switch (ev.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end": {
      const usage = (ev.message as { usage?: unknown }).usage;
      return { type: "turn_end", usage };
    }
    case "message_start":
      return { type: "message_start", role: (ev.message as { role?: string }).role };
    case "message_end":
      return { type: "message_end", role: (ev.message as { role?: string }).role };
    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (a.type === "text_delta") return { type: "text_delta", delta: a.delta };
      if (a.type === "thinking_delta") return { type: "thinking_delta", delta: a.delta };
      if (a.type === "error") {
        return { type: "error", message: `Model error (${a.reason})`, reason: a.reason };
      }
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
      };
    case "tool_execution_update":
      return { type: "tool_update", toolCallId: ev.toolCallId, toolName: ev.toolName };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        isError: ev.isError,
        result: cap(ev.result),
      };
    case "queue_update":
      return { type: "queue_update", steering: ev.steering, followUp: ev.followUp };
    case "auto_retry_start":
      return { type: "retry", attempt: ev.attempt, max: ev.maxAttempts };
    default:
      return null;
  }
}
