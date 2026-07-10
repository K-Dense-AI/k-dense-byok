/**
 * Map Pi's AgentSessionEvent union onto a stable, compact SSE schema the
 * frontend consumes. We deliberately flatten the streaming deltas and drop
 * Pi-internal lifecycle noise so the client contract stays small.
 */
import type { AgentSessionEvent, ContextUsage } from "@earendil-works/pi-coding-agent";
import { skillLabelForRead } from "./skill-label.ts";

export interface ClientFrame {
  type: string;
  [k: string]: unknown;
}

/** Keep Pi's context-utilization shape explicit on the wire. */
export function contextUsageFrame(usage: ContextUsage | undefined): ClientFrame | null {
  if (!usage) return null;
  return {
    type: "context_usage",
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  };
}

/** Frontmatter skill name when a `read` call is a skill activation. */
export function skillFieldFor(
  toolName: string,
  args: unknown,
  sandboxRoot: string,
): { skill: string } | undefined {
  if (toolName !== "read") return undefined;
  const p = (args as { path?: unknown } | null | undefined)?.path;
  const skill = skillLabelForRead(p, sandboxRoot);
  return skill ? { skill } : undefined;
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
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matcher for every spelling of the sandbox root worth stripping. Windows-ness
 * is derived from the root string itself (contains "\") so behavior is
 * unit-testable anywhere; on a Windows root, matching also covers the
 * forward-slash spelling, either separator after the root, and any casing
 * (NTFS is case-insensitive — drive letters routinely arrive lowercased).
 */
interface RootMatcher {
  /** Prefix-strip one exact path string; null when no root prefix matches. */
  strip(value: string): string | null;
  /** Strip embedded occurrences inside larger strings (bash commands etc.). */
  stripEmbedded(value: string): string;
}

function rootMatcher(sandboxRoot: string): RootMatcher {
  const win = sandboxRoot.includes("\\");
  const roots = win ? [sandboxRoot, sandboxRoot.replaceAll("\\", "/")] : [sandboxRoot];
  const seps = win ? ["\\", "/"] : ["/"];
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  const toWire = (s: string) => (win ? s.replaceAll("\\", "/") : s);
  // root+sep followed by the rest of the path token: the tail is kept but its
  // separators are normalized to the wire format.
  const embedded = roots.flatMap((root) =>
    seps.map((sep) => new RegExp(escapeRe(root + sep) + "([^\\s\"'`]*)", win ? "gi" : "g")),
  );
  const bare = roots.map((root) => new RegExp(escapeRe(root), win ? "gi" : "g"));
  return {
    strip(value) {
      for (const root of roots) {
        if (norm(value) === norm(root)) return ".";
        for (const sep of seps) {
          const prefix = root + sep;
          if (norm(value.slice(0, prefix.length)) === norm(prefix)) {
            return toWire(value.slice(prefix.length));
          }
        }
      }
      return null;
    },
    stripEmbedded(value) {
      let s = value;
      for (const re of embedded) s = s.replace(re, (_, tail: string) => toWire(tail));
      for (const re of bare) s = s.replace(re, ".");
      return s;
    },
  };
}

/** Strip an exact sandbox-root prefix off one path string; output is always
 *  wire-format (forward slashes). Non-sandbox paths pass through unchanged. */
export function stripSandboxRoot(value: string, sandboxRoot: string): string {
  if (!sandboxRoot) return value;
  return rootMatcher(sandboxRoot).strip(value) ?? value;
}

export function relativizeSandboxPaths<T>(value: T, sandboxRoot: string): T {
  if (!sandboxRoot) return value;
  // One matcher for the whole event/transcript — the root is constant.
  return relativizeWith(value, rootMatcher(sandboxRoot));
}

function relativizeWith<T>(value: T, matcher: RootMatcher): T {
  if (typeof value === "string") {
    const stripped = matcher.strip(value) ?? value;
    // Embedded references (inside bash commands, multi-path args, etc.).
    return matcher.stripEmbedded(stripped) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => relativizeWith(v, matcher)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = relativizeWith(v, matcher);
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

/** Flatten a user message's content (string or content-part array) to plain
 *  text. Image parts are dropped — the UI renders steered messages as text. */
function userMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
    case "message_start": {
      const role = (ev.message as { role?: string }).role;
      // User content marks the exact point a steered message was delivered
      // into the run, so the client can split the transcript there.
      if (role === "user") {
        return { type: "message_start", role, content: userMessageText(ev.message) };
      }
      return { type: "message_start", role };
    }
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
        ...skillFieldFor(ev.toolName, ev.args, sandboxRoot),
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
