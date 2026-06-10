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

/**
 * Rewrite absolute sandbox paths to sandbox-relative ones for display.
 *
 * Tool args and bash commands from Pi carry the real host path of the project
 * sandbox (e.g. `/Users/.../projects/<id>/sandbox/de_analysis.py`). Surfacing
 * that in the UI and in shared exports is noisy and leaks the user's
 * filesystem layout. We collapse the sandbox root to a relative path:
 *   - an exact path field `<root>/de_analysis.py` → `de_analysis.py`
 *   - an embedded occurrence in a command (`cd <root> && …`) → `cd . && …`
 */
export function relativizeSandboxPaths<T>(value: T, sandboxRoot: string): T {
  if (!sandboxRoot) return value;
  if (typeof value === "string") {
    let s: string = value;
    if (s === sandboxRoot) return "." as unknown as T;
    if (s.startsWith(sandboxRoot + "/")) s = s.slice(sandboxRoot.length + 1);
    // Embedded references (inside bash commands, multi-path args, etc.).
    s = s.split(sandboxRoot + "/").join("").split(sandboxRoot).join(".");
    return s as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => relativizeSandboxPaths(v, sandboxRoot)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = relativizeSandboxPaths(v, sandboxRoot);
    }
    return out as T;
  }
  return value;
}

/** Pull human-readable text out of a Pi tool result before capping it.
 *  Results are usually `[{type:"text", text:"…"}]`; fall back to JSON. */
function resultText(s: unknown): string {
  if (typeof s === "string") return s;
  if (Array.isArray(s)) {
    const parts = s
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : null,
      )
      .filter((t): t is string => t !== null);
    if (parts.length) return parts.join("\n");
  }
  if (s && typeof s === "object") {
    const content = (s as { content?: unknown }).content;
    if (content !== undefined) return resultText(content);
  }
  return JSON.stringify(s ?? "");
}

function cap(s: unknown, max = 4000): string {
  const str = resultText(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Returns a client frame for an event, or null to skip it.
 *  `sandboxRoot` (when provided) relativizes absolute sandbox paths in tool
 *  args so the UI shows `de_analysis.py` rather than the full host path. */
export function toClientFrame(
  ev: AgentSessionEvent,
  sandboxRoot = "",
): ClientFrame | null {
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
        args: relativizeSandboxPaths(ev.args, sandboxRoot),
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
