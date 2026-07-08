/**
 * Replay a stored Pi session JSONL file as the client SSE frame vocabulary.
 *
 * Reload recovery: the frontend rebuilds a past chat by folding these frames
 * through the same reducer it uses for live streams (applyFrameToMessage), so
 * a reopened transcript renders exactly like it did while streaming — prose,
 * reasoning blocks, and tool activity rows with args and capped results.
 */
import { relativizeSandboxPaths, skillFieldFor, type ClientFrame } from "./events.ts";
import {
  readRows,
  textOf,
  type TextPart,
  type ThinkingPart,
  type ToolCallPart,
} from "./session-export.ts";

export interface HistoryMessage {
  role: "user" | "assistant";
  /** Prompt text — user messages only. */
  content?: string;
  /** Inline image attachments (base64 + mime type) — user messages only. */
  images?: { data: string; mimeType: string }[];
  /** Ordered replay frames — assistant messages only. */
  frames?: ClientFrame[];
  /** Wall-clock ms of the underlying log row, when recorded. */
  timestamp?: number;
}

/** Matches the live-stream result cap in events.ts. */
const RESULT_CAP = 4000;

function capResult(parts: { type: string; text?: string }[] | undefined): string {
  if (!parts) return "";
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  return text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + "…" : text;
}

/** Inline image parts of a user message (prompt attachments). */
function imagesOf(content: { type: string }[]): { data: string; mimeType: string }[] {
  const out: { data: string; mimeType: string }[] = [];
  for (const part of content ?? []) {
    if (part.type !== "image") continue;
    const { data, mimeType } = part as { data?: unknown; mimeType?: unknown };
    if (typeof data === "string" && typeof mimeType === "string") {
      out.push({ data, mimeType });
    }
  }
  return out;
}

export function toHistory(file: string, sandboxRoot = ""): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  // One assistant history message accumulates every agent turn between two
  // user prompts — the same shape the live stream produces client-side.
  let assistant: HistoryMessage | null = null;
  const pushFrame = (f: ClientFrame, timestamp?: number) => {
    if (!assistant) {
      assistant = { role: "assistant", frames: [], timestamp };
      out.push(assistant);
    }
    assistant.frames!.push(f);
  };

  for (const row of readRows(file)) {
    const m = row.message;
    if (m.role === "user") {
      const text = textOf(m.content);
      const images = imagesOf(m.content);
      if (!text && images.length === 0) continue;
      out.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
        timestamp: m.timestamp,
      });
      assistant = null;
      continue;
    }
    if (m.role === "toolResult" && m.toolCallId) {
      pushFrame(
        {
          type: "tool_end",
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          isError: Boolean(m.isError),
          result: capResult(m.content as { type: string; text?: string }[]),
        },
        m.timestamp,
      );
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const part of m.content ?? []) {
      if (part.type === "thinking") {
        const t = (part as ThinkingPart).thinking;
        if (t) pushFrame({ type: "thinking_delta", delta: t }, m.timestamp);
      } else if (part.type === "text") {
        const t = (part as TextPart).text;
        if (t) pushFrame({ type: "text_delta", delta: t }, m.timestamp);
      } else if (part.type === "toolCall") {
        const call = part as ToolCallPart;
        pushFrame(
          {
            type: "tool_start",
            toolCallId: call.id,
            toolName: call.name,
            args: relativizeSandboxPaths(call.arguments ?? {}, sandboxRoot),
            ...skillFieldFor(call.name, call.arguments, sandboxRoot),
          },
          m.timestamp,
        );
      }
    }
  }
  return out;
}
