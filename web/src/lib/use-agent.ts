"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, onProjectChange } from "@/lib/projects";

// Keep the full tool-call trace per message: scientists rely on it to see and
// reproduce what the agent ran, and the session export reads it too.
const MAX_ACTIVITY_ITEMS = 200;

export interface ActivityItem {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "complete" | "error";
  timestamp: number;
  /** Raw tool name (e.g. "bash", "write") for icon + summary rendering. */
  toolName?: string;
  /** Tool arguments captured from tool_start (e.g. the bash command). */
  args?: unknown;
  /** Tool result text captured from tool_end (truncated server-side). */
  result?: string;
}

// Retained for backwards-compatible imports; citation verification is deferred
// in the Pi migration and these are no longer populated.
export type CitationKind = "doi" | "arxiv" | "pubmed" | "url";
export type CitationStatus = "verified" | "unresolved" | "skipped";
export interface CitationEntry {
  raw: string;
  kind: CitationKind;
  identifier: string;
  status: CitationStatus;
  title?: string | null;
  url?: string | null;
  resolvedAt?: number | null;
  error?: string | null;
}
export interface CitationReport {
  total: number;
  verified: number;
  unresolved: number;
  entries: CitationEntry[];
  loading?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  activities?: ActivityItem[];
  reasoning?: string;
  modelVersion?: string;
  timestamp: number;
  /** Per-turn cost (USD) for this assistant message, from the terminal `cost` frame. */
  runCostUsd?: number;
  /** Per-turn token total for this assistant message. */
  runTokens?: number;
  /** Retained for compatibility; no longer populated under the Pi backend. */
  turnId?: string;
  citations?: CitationReport;
}

type Status = "ready" | "submitted" | "streaming" | "error";

/** A frame from the backend SSE stream (see server/src/agent/events.ts). */
export interface AgentFrame {
  type: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  message?: string;
  args?: unknown;
  result?: string;
  runCost?: number;
  runTokens?: number;
  role?: string;
  content?: string;
  steering?: unknown;
  [k: string]: unknown;
}

const humanizeToolName = (name: string) => name.replace(/_/g, " ");

/** Apply one SSE frame to the in-progress assistant message. */
export function applyFrameToMessage(
  message: ChatMessage,
  frame: AgentFrame,
  now = Date.now(),
): ChatMessage {
  switch (frame.type) {
    case "text_delta":
      return { ...message, content: message.content + (frame.delta ?? "") };
    case "thinking_delta":
      return { ...message, reasoning: (message.reasoning ?? "") + (frame.delta ?? "") };
    case "tool_start": {
      const id = String(frame.toolCallId ?? frame.toolName ?? now);
      const label =
        frame.toolName === "subagent"
          ? "Running a subagent"
          : `Running ${humanizeToolName(String(frame.toolName ?? "tool"))}`;
      const activities = message.activities ?? [];
      if (activities.some((a) => a.id === id && a.status === "running")) return message;
      // A tool call interrupts the assistant's prose. Close off the current
      // paragraph so text that resumes after the tool doesn't get glued onto
      // the previous sentence (which broke headings/markdown — e.g.
      // "…by condition:## Results").
      const content =
        message.content && !message.content.endsWith("\n")
          ? message.content + "\n\n"
          : message.content;
      return {
        ...message,
        content,
        activities: [
          ...activities,
          {
            id,
            label,
            status: "running" as const,
            timestamp: now,
            toolName: frame.toolName ? String(frame.toolName) : undefined,
            args: frame.args,
          },
        ].slice(-MAX_ACTIVITY_ITEMS),
      };
    }
    case "tool_end": {
      const id = String(frame.toolCallId ?? frame.toolName ?? now);
      const activities = message.activities ?? [];
      const idx = activities.findIndex((a) => a.id === id);
      const status: ActivityItem["status"] = frame.isError ? "error" : "complete";
      if (idx === -1) return message;
      const next = [...activities];
      next[idx] = {
        ...next[idx],
        status,
        result: typeof frame.result === "string" ? frame.result : next[idx].result,
      };
      return { ...message, activities: next };
    }
    case "cost":
      return {
        ...message,
        runCostUsd:
          typeof frame.runCost === "number" ? frame.runCost : message.runCostUsd,
        runTokens:
          typeof frame.runTokens === "number" ? frame.runTokens : message.runTokens,
      };
    case "error": {
      // Append rather than replace: an error after partial output (mid-stream
      // provider failure) must not be silently dropped.
      const errorText = `Error: ${frame.message ?? "request failed"}`;
      return {
        ...message,
        content: message.content ? `${message.content}\n\n${errorText}` : errorText,
      };
    }
    default:
      return message;
  }
}

export interface TranscriptRunState {
  /** Id of the assistant bubble frames currently apply to. */
  assistantId: string;
  /** True once the run's own prompt echoed back as a user message_start. */
  sawPromptEcho: boolean;
}

export interface TranscriptResult {
  messages: ChatMessage[];
  state: TranscriptRunState;
  /** Pending steering texts when the frame updated them; null otherwise. */
  steering: string[] | null;
}

/**
 * Apply one SSE frame to a run's transcript. Pure; returns the input
 * `messages` reference when nothing changed so callers can skip re-renders.
 * A user message_start after the initial prompt echo is a delivered steering
 * message: it closes the current assistant bubble and opens a new one.
 */
export function applyFrameToTranscript(
  messages: ChatMessage[],
  state: TranscriptRunState,
  frame: AgentFrame,
  nextId: () => string,
  now = Date.now(),
): TranscriptResult {
  if (frame.type === "queue_update") {
    const steering = Array.isArray(frame.steering) ? frame.steering.map(String) : [];
    return { messages, state, steering };
  }
  if (frame.type === "message_start" && frame.role === "user") {
    if (!state.sawPromptEcho) {
      return { messages, state: { ...state, sawPromptEcho: true }, steering: null };
    }
    const content = typeof frame.content === "string" ? frame.content : "";
    if (!content.trim()) return { messages, state, steering: null };
    const userId = nextId();
    const assistantId = nextId();
    return {
      messages: [
        ...messages,
        { id: userId, role: "user", content, timestamp: now },
        { id: assistantId, role: "assistant", content: "", timestamp: now },
      ],
      state: { ...state, assistantId },
      steering: null,
    };
  }
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== state.assistantId) return m;
    const applied = applyFrameToMessage(m, frame, now);
    if (applied !== m) changed = true;
    return applied;
  });
  return { messages: changed ? next : messages, state, steering: null };
}

/** One transcript entry from GET /sessions/:id/history. */
interface HistoryItem {
  role: "user" | "assistant";
  content?: string;
  frames?: AgentFrame[];
  timestamp?: number;
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("ready");
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messageCounter = useRef(0);

  const nextId = () => String(++messageCounter.current);

  /**
   * Hydrate this (untouched) tab from a stored session's transcript, and bind
   * the tab to that session so follow-up sends continue the conversation.
   * The server replays the JSONL log as the same frames the live stream
   * emits, so the restored transcript renders identically.
   */
  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    // Never swap the session out from under a tab that already has one.
    if (sessionIdRef.current) return false;
    try {
      const res = await apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}/history`,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { messages?: HistoryItem[] };
      // Re-check after the awaits: a message sent while the history fetch was
      // in flight binds the tab to a fresh session, which must win.
      if (sessionIdRef.current) return false;
      const restored: ChatMessage[] = [];
      const fallbackTs = Date.now();
      for (const item of data.messages ?? []) {
        const timestamp = item.timestamp ?? fallbackTs;
        if (item.role === "user") {
          restored.push({
            id: nextId(),
            role: "user",
            content: item.content ?? "",
            timestamp,
          });
          continue;
        }
        let msg: ChatMessage = {
          id: nextId(),
          role: "assistant",
          content: "",
          timestamp,
        };
        for (const frame of item.frames ?? []) {
          msg = applyFrameToMessage(msg, frame, timestamp);
        }
        // A stored log has no live spinner left to resolve.
        msg = {
          ...msg,
          activities: (msg.activities ?? []).map((a) =>
            a.status === "running" ? { ...a, status: "complete" as const } : a,
          ),
        };
        restored.push(msg);
      }
      sessionIdRef.current = sessionId;
      setMessages(restored);
      setStatus("ready");
      return true;
    } catch {
      return false;
    }
  }, []);

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const res = await apiFetch(`/sessions`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const session = await res.json();
    sessionIdRef.current = session.id;
    return session.id as string;
  }, []);

  const send = useCallback(
    // The optional third arg (expert model / attachments / skills / databases)
    // is accepted for call-site compatibility but no longer used: the Pi
    // backend runs a single flat agent. Skill/database hints are still injected
    // into the prompt text by the caller. `computeTarget` is the selected Modal
    // instance id, forwarded so the modal_run tool defaults to it.
    async (
      text: string,
      model?: string,
      _legacyMeta?: unknown,
      fusionConfig?: Record<string, unknown>,
      computeTarget?: string,
    ): Promise<string | undefined> => {
      if (!text.trim() || status === "submitted" || status === "streaming") return;

      const userMsgId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", content: text, timestamp: Date.now() },
      ]);
      setStatus("submitted");

      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", timestamp: Date.now() },
      ]);

      const updateAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? updater(m) : m)),
        );
      };

      try {
        const sessionId = await ensureSession();
        const controller = new AbortController();
        abortRef.current = controller;

        const startRun = () =>
          apiFetch(`/sessions/${sessionId}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: text,
              ...(model ? { model } : {}),
              ...(fusionConfig ? { fusionConfig } : {}),
              ...(computeTarget && computeTarget !== "local" ? { computeTarget } : {}),
            }),
            signal: controller.signal,
          });
        let res = await startRun();
        // 409 = previous run still unwinding server-side (e.g. right after
        // Stop, whose abort completes asynchronously). Retry briefly instead
        // of losing the message.
        for (let attempt = 0; res.status === 409 && attempt < 4; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          res = await startRun();
        }
        if (!res.ok) throw new Error(`run failed: ${res.status}`);
        setStatus("streaming");

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            try {
              const frame = JSON.parse(jsonStr) as AgentFrame;
              updateAssistant((m) => applyFrameToMessage(m, frame));
            } catch {
              /* skip malformed line */
            }
          }
        }

        updateAssistant((m) => ({
          ...m,
          activities: (m.activities ?? []).map((a) =>
            a.status === "running" ? { ...a, status: "complete" } : a,
          ),
        }));
        setStatus("ready");
      } catch (err: unknown) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        updateAssistant((m) => ({
          ...m,
          content: aborted ? m.content : m.content || "Something went wrong. Please try again.",
          activities: (m.activities ?? []).map((a) =>
            a.status === "running" ? { ...a, status: aborted ? "complete" : "error" } : a,
          ),
        }));
        setStatus(aborted ? "ready" : "error");
      } finally {
        abortRef.current = null;
      }

      return userMsgId;
    },
    [status, ensureSession],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    const id = sessionIdRef.current;
    if (id) void apiFetch(`/sessions/${id}/abort`, { method: "POST" }).catch(() => {});
    setStatus("ready");
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("ready");
    sessionIdRef.current = null;
  }, []);

  useEffect(() => onProjectChange(() => reset()), [reset]);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  return { messages, status, send, stop, reset, getSessionId, loadSession };
}
