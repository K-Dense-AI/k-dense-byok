"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, onProjectChange } from "@/lib/projects";

const APP_NAME = "kady_agent";
const USER_ID = "user";
const MAX_ACTIVITY_ITEMS = 8;

export interface ActivityItem {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "complete" | "error";
  timestamp: number;
}

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
  modelVersion?: string;
  timestamp: number;
  turnId?: string;
  citations?: CitationReport;
}

type Status = "ready" | "submitted" | "streaming" | "error";

type ToolCallPart = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

type ToolResponsePart = {
  id?: string;
  name?: string;
  response?: Record<string, unknown>;
};

type AgentEvent = {
  error?: unknown;
  modelVersion?: string;
  partial?: boolean;
  actions?: {
    stateDelta?: Record<string, unknown>;
    state_delta?: Record<string, unknown>;
  };
  content?: {
    parts?: Array<{
      functionCall?: ToolCallPart;
      functionResponse?: ToolResponsePart;
      text?: string;
    }>;
  };
};

const truncateText = (value: unknown, max = 120) => {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}...`;
};

const humanizeToolName = (name: string) => name.replace(/_/g, " ");

const formatToolCall = (tool: ToolCallPart) => {
  const name = tool.name ?? "tool";
  const prompt = truncateText(tool.args?.prompt);

  if (name === "delegate_task") {
    return {
      detail: prompt,
      label: "Delegating to a specialist",
    };
  }

  return {
    detail: prompt,
    label: `Running ${humanizeToolName(name)}`,
  };
};

const formatSkillsList = (skills: unknown): string | undefined => {
  if (!Array.isArray(skills) || skills.length === 0) return undefined;
  const names = skills.filter((s): s is string => typeof s === "string");
  if (names.length === 0) return undefined;
  return names.map((s) => `'${s}'`).join(", ");
};

const formatToolResponse = (tool: ToolResponsePart) => {
  const name = tool.name ?? "tool";
  const result =
    truncateText(tool.response?.result) ??
    truncateText(tool.response?.message) ??
    truncateText(tool.response?.error);
  const status = tool.response?.error ? "error" : "complete";

  if (name === "delegate_task") {
    const skills = formatSkillsList(tool.response?.skills_used);
    return {
      detail: skills ? `Used ${skills} skills` : result,
      label: "Specialist finished",
      status,
    } as const;
  }

  return {
    detail: result,
    label: `Finished ${humanizeToolName(name)}`,
    status,
  } as const;
};

export function applyAgentEventToMessage(
  message: ChatMessage,
  event: AgentEvent,
  nextActivityId: () => string,
  now = Date.now()
): ChatMessage {
  let next = message;
  if (event.error) {
    next = { ...next, content: `Error: ${event.error}` };
  }

  if (event.modelVersion) {
    next = { ...next, modelVersion: event.modelVersion };
  }

  const stateDelta = event.actions?.stateDelta ?? event.actions?.state_delta;
  if (stateDelta && typeof stateDelta === "object") {
    const nextTurnId = stateDelta._turnId;
    if (typeof nextTurnId === "string") {
      next = { ...next, turnId: nextTurnId };
    }
  }

  const parts = event.content?.parts;
  if (!parts) return next;

  for (const part of parts) {
    if (part.functionCall) {
      const tool = part.functionCall;
      const activity = formatToolCall(tool);
      const key = String(tool.id ?? tool.name ?? nextActivityId());
      const activities = next.activities ?? [];
      if (
        activities.some(
          (existing) => existing.id === key && existing.status === "running"
        )
      ) {
        continue;
      }
      next = {
        ...next,
        activities: [
          ...activities,
          {
            detail: activity.detail,
            id: key,
            label: activity.label,
            status: "running" as const,
            timestamp: now,
          },
        ].slice(-MAX_ACTIVITY_ITEMS),
      };
      continue;
    }

    if (part.functionResponse) {
      const tool = part.functionResponse;
      const activity = formatToolResponse(tool);
      const key = String(tool.id ?? tool.name ?? nextActivityId());
      const activities = next.activities ?? [];
      const existingIndex = activities.findIndex(
        (existing) =>
          existing.id === key ||
          (tool.name &&
            existing.status === "running" &&
            existing.label.toLowerCase().includes(humanizeToolName(tool.name)))
      );

      if (existingIndex === -1) {
        next = {
          ...next,
          activities: [
            ...activities,
            {
              detail: activity.detail,
              id: key,
              label: activity.label,
              status: activity.status as ActivityItem["status"],
              timestamp: now,
            },
          ].slice(-MAX_ACTIVITY_ITEMS),
        };
        continue;
      }

      const nextActivities = [...activities];
      nextActivities[existingIndex] = {
        ...nextActivities[existingIndex],
        detail: activity.detail ?? nextActivities[existingIndex].detail,
        label: activity.label,
        status: activity.status,
      };
      next = { ...next, activities: nextActivities };
      continue;
    }

    if (part.text) {
      next = {
        ...next,
        content: event.partial ? next.content + part.text : part.text,
      };
    }
  }

  return next;
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

    const res = await apiFetch(
      `/apps/${APP_NAME}/users/${USER_ID}/sessions`,
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const session = await res.json();
    sessionIdRef.current = session.id;
    return session.id as string;
  }, []);

  const send = useCallback(
    async (
      text: string,
      model?: string,
      meta?: {
        expertModel?: string;
        attachments?: string[];
        skills?: string[];
        databases?: string[];
        compute?: string | null;
      }
    ): Promise<string | undefined> => {
      if (!text.trim() || status === "submitted" || status === "streaming") return;

      const userMsgId = nextId();
      const userMsg: ChatMessage = { id: userMsgId, role: "user", content: text, timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setStatus("submitted");

      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", timestamp: Date.now() },
      ]);

      try {
        const sessionId = await ensureSession();
        const controller = new AbortController();
        abortRef.current = controller;
        const updateAssistant = (
          updater: (message: ChatMessage) => ChatMessage
        ) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? updater(message) : message
            )
          );
        };

        const stateDelta: Record<string, unknown> = {};
        if (model) stateDelta._model = model;
        if (meta?.expertModel) stateDelta._expertModel = meta.expertModel;
        if (meta?.attachments?.length) stateDelta._attachments = meta.attachments;
        if (meta?.skills?.length) stateDelta._skills = meta.skills;
        if (meta?.databases?.length) stateDelta._databases = meta.databases;
        if (meta?.compute) stateDelta._compute = meta.compute;

        const res = await apiFetch(`/run_sse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId,
            newMessage: {
              role: "user",
              parts: [{ text }],
            },
            streaming: true,
            ...(Object.keys(stateDelta).length > 0 ? { state_delta: stateDelta } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`SSE request failed: ${res.status}`);
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
              const event = JSON.parse(jsonStr);

              updateAssistant((message) =>
                applyAgentEventToMessage(message, event, nextId)
              );
            } catch {
              // skip malformed JSON lines
            }
          }
        }

        updateAssistant((message) => ({
          ...message,
          activities: (message.activities ?? []).map((activity) =>
            activity.status === "running"
              ? { ...activity, status: "complete" }
              : activity
          ),
        }));
        setStatus("ready");

        // Fire-and-forget deterministic citation verification on the final
        // assistant text plus any deliverable files the expert produced.
        // The badge hydrates asynchronously; unresolved citations reveal
        // themselves in the popover.
        void (async () => {
          const finalMessage = await new Promise<ChatMessage | undefined>(
            (resolve) =>
              setMessages((prev) => {
                resolve(prev.find((m) => m.id === assistantId));
                return prev;
              })
          );
          const text = finalMessage?.content ?? "";
          const turnId = finalMessage?.turnId;
          if (!text.trim()) return;

          updateAssistant((message) => ({
            ...message,
            citations: {
              total: 0,
              verified: 0,
              unresolved: 0,
              entries: [],
              loading: true,
            },
          }));

          let deliverables: string[] = [];
          if (turnId && sessionIdRef.current) {
            try {
              const mResp = await apiFetch(
                `/turns/${sessionIdRef.current}/${turnId}/manifest`
              );
              if (mResp.ok) {
                const manifest = await mResp.json();
                if (Array.isArray(manifest?.output?.deliverables)) {
                  deliverables = manifest.output.deliverables;
                }
              }
            } catch {
              // best-effort
            }
          }

          try {
            const resp = await apiFetch(`/verify-citations`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, files: deliverables }),
            });
            if (!resp.ok) throw new Error(`verify-citations ${resp.status}`);
            const report = (await resp.json()) as CitationReport;
            updateAssistant((message) => ({
              ...message,
              citations: { ...report, loading: false },
            }));

            if (turnId && sessionIdRef.current) {
              void apiFetch(
                `/turns/${sessionIdRef.current}/${turnId}/citations`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    total: report.total,
                    verified: report.verified,
                    unresolved: report.unresolved,
                  }),
                }
              ).catch(() => {});
            }
          } catch {
            updateAssistant((message) => ({
              ...message,
              citations: undefined,
            }));
          }
        })();
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    activities: (message.activities ?? []).map((activity) =>
                      activity.status === "running"
                        ? { ...activity, status: "error" }
                        : activity
                    ),
                  }
                : message
            )
          );
          setStatus("ready");
          return;
        }
        setStatus("error");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  activities: (m.activities ?? []).map((activity) =>
                    activity.status === "running"
                      ? { ...activity, status: "error" }
                      : activity
                  ),
                  content: "Something went wrong. Please try again.",
                }
              : m
          )
        );
      } finally {
        abortRef.current = null;
      }

      return userMsgId;
    },
    [status, ensureSession]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStatus("ready");
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("ready");
    sessionIdRef.current = null;
  }, []);

  // Switching projects must drop the current ADK session (it lives in a
  // different per-project SQLite DB) and start fresh.
  useEffect(() => onProjectChange(() => reset()), [reset]);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  return { messages, status, send, stop, reset, getSessionId };
}
