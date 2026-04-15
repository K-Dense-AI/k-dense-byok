"use client";

import { useCallback, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api-base";
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  activities?: ActivityItem[];
  modelVersion?: string;
  timestamp: number;
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

const createActivityItem = (activity: {
  detail?: string;
  id: string;
  label: string;
  status: ActivityItem["status"];
}): ActivityItem => ({
  ...activity,
  timestamp: Date.now(),
});

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

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("ready");
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messageCounter = useRef(0);

  const nextId = () => String(++messageCounter.current);

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    const res = await fetch(
      `${getApiBaseUrl()}/apps/${APP_NAME}/users/${USER_ID}/sessions`,
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const session = await res.json();
    sessionIdRef.current = session.id;
    return session.id as string;
  }, []);

  const send = useCallback(
    async (text: string, model?: string): Promise<string | undefined> => {
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

        const res = await fetch(`${getApiBaseUrl()}/run_sse`, {
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
            ...(model ? { state_delta: { _model: model } } : {}),
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

              if (event.error) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: `Error: ${event.error}` }
                      : m
                  )
                );
                continue;
              }

              if (event.modelVersion) {
                updateAssistant((message) => ({
                  ...message,
                  modelVersion: event.modelVersion,
                }));
              }

              const parts = event.content?.parts;
              if (!parts) continue;

              for (const part of parts) {
                if (part.functionCall) {
                  const tool = part.functionCall as ToolCallPart;
                  const activity = formatToolCall(tool);
                  const key = String(tool.id ?? tool.name ?? nextId());

                  updateAssistant((message) => {
                    const activities = message.activities ?? [];
                    if (
                      activities.some(
                        (existing) =>
                          existing.id === key && existing.status === "running"
                      )
                    ) {
                      return message;
                    }

                    return {
                      ...message,
                      activities: [
                        ...activities,
                        createActivityItem({
                          detail: activity.detail,
                          id: key,
                          label: activity.label,
                          status: "running",
                        }),
                      ].slice(-MAX_ACTIVITY_ITEMS),
                    };
                  });
                  continue;
                }

                if (part.functionResponse) {
                  const tool = part.functionResponse as ToolResponsePart;
                  const activity = formatToolResponse(tool);
                  const key = String(tool.id ?? tool.name ?? nextId());

                  updateAssistant((message) => {
                    const activities = message.activities ?? [];
                    const existingIndex = activities.findIndex(
                      (existing) =>
                        existing.id === key ||
                        (tool.name &&
                          existing.status === "running" &&
                          existing.label
                            .toLowerCase()
                            .includes(humanizeToolName(tool.name)))
                    );

                    if (existingIndex === -1) {
                      return {
                        ...message,
                        activities: [
                          ...activities,
                          createActivityItem({
                            detail: activity.detail,
                            id: key,
                            label: activity.label,
                            status: activity.status,
                          }),
                        ].slice(-MAX_ACTIVITY_ITEMS),
                      };
                    }

                    const nextActivities = [...activities];
                    nextActivities[existingIndex] = {
                      ...nextActivities[existingIndex],
                      detail:
                        activity.detail ?? nextActivities[existingIndex].detail,
                      label: activity.label,
                      status: activity.status,
                    };

                    return {
                      ...message,
                      activities: nextActivities,
                    };
                  });
                  continue;
                }

                if (part.text) {
                  if (event.partial) {
                    // Streaming chunk: append to existing content
                    updateAssistant((message) => ({
                      ...message,
                      content: message.content + part.text,
                    }));
                  } else {
                    // Complete event: replace with final content
                    updateAssistant((message) => ({
                      ...message,
                      content: part.text,
                    }));
                  }
                }
              }
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

  return { messages, status, send, stop, reset };
}
