"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, onProjectChange } from "@/lib/projects";

const MAX_ACTIVITY_ITEMS = 8;

export interface ActivityItem {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "complete" | "error";
  timestamp: number;
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
        frame.toolName === "spawn_subagent"
          ? "Spawning a subagent"
          : `Running ${humanizeToolName(String(frame.toolName ?? "tool"))}`;
      const activities = message.activities ?? [];
      if (activities.some((a) => a.id === id && a.status === "running")) return message;
      return {
        ...message,
        activities: [
          ...activities,
          { id, label, status: "running" as const, timestamp: now },
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
      next[idx] = { ...next[idx], status };
      return { ...message, activities: next };
    }
    case "error":
      return {
        ...message,
        content: message.content || `Error: ${frame.message ?? "request failed"}`,
      };
    default:
      return message;
  }
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("ready");
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messageCounter = useRef(0);

  const nextId = () => String(++messageCounter.current);

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
    // The optional third arg (expert model / attachments / skills / databases /
    // compute) is accepted for call-site compatibility but no longer used: the
    // Pi backend runs a single flat agent. Skill/database hints are still
    // injected into the prompt text by the caller.
    async (text: string, model?: string, _legacyMeta?: unknown): Promise<string | undefined> => {
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

        const res = await apiFetch(`/sessions/${sessionId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, ...(model ? { model } : {}) }),
          signal: controller.signal,
        });
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

  return { messages, status, send, stop, reset, getSessionId };
}
