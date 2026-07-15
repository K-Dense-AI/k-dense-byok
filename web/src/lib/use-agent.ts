"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";

import type { PromptImage } from "./image-attachments";
import { parseNotebookFrame, mergeNotebookEntries, type NotebookEntry } from "./notebook";

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
  /** Frontmatter skill name when this read is a skill activation (server-resolved). */
  skillName?: string;
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
  /** Inline image attachments — user messages only. */
  images?: PromptImage[];
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

export interface ContextUsage {
  /** Pi cannot estimate this immediately after compaction. */
  tokens: number | null;
  contextWindow: number;
  /** Percentage of the current model's context window, null while recalculating. */
  percent: number | null;
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const tokens = candidate.tokens;
  const contextWindow = candidate.contextWindow;
  const percent = candidate.percent;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) ||
    (percent !== null &&
      (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0))
  ) {
    return null;
  }
  return { tokens, contextWindow, percent } as ContextUsage;
}

type Status = "ready" | "submitted" | "streaming" | "error";
export type AgentRunState = "idle" | "running" | "done" | "error" | "blocked";

/** A frame from the backend SSE stream (see server/src/agent/events.ts). */
export interface AgentFrame {
  type: string;
  delta?: string;
  toolName?: string;
  /** Frontmatter skill name attached to tool_start when the read is a skill activation. */
  skill?: string;
  toolCallId?: string;
  isError?: boolean;
  kind?: string;
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
            skillName: typeof frame.skill === "string" ? frame.skill : undefined,
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
export interface HistoryItem {
  role: "user" | "assistant";
  content?: string;
  images?: PromptImage[];
  frames?: AgentFrame[];
  timestamp?: number;
}

export interface SequencedAgentFrame extends AgentFrame {
  seq: number;
}

interface RunSnapshot {
  runId: string;
  prompt: string;
  images: PromptImage[];
  baseline: {
    messages: HistoryItem[];
    contextUsage: unknown;
  };
  frames: SequencedAgentFrame[];
  lastSeq: number;
}

interface RunStateResponse {
  status: "none" | "running" | "complete";
  run?: RunSnapshot;
}

interface RunConsumer {
  transcript: ChatMessage[];
  transcriptState: TranscriptRunState;
  lastSeq: number;
  currentRunId?: string;
  outcome: AgentRunState;
  sawDone: boolean;
}

/**
 * JSON body for POST /sessions/:id/run. Pure so tests can pin the wire shape.
 * `thinkingLevel: "off"` is deliberately sent (not stripped): Pi sessions
 * remember the level across runs, so an explicit off resets a raised one.
 * Callers omit the field entirely for models without adjustable thinking.
 */
export function buildRunBody(opts: {
  message: string;
  model?: string;
  fusionConfig?: Record<string, unknown>;
  computeTarget?: string;
  thinkingLevel?: string;
  images?: PromptImage[];
}): Record<string, unknown> {
  const { message, model, fusionConfig, computeTarget, thinkingLevel, images } = opts;
  return {
    message,
    ...(model ? { model } : {}),
    ...(fusionConfig ? { fusionConfig } : {}),
    ...(computeTarget && computeTarget !== "local" ? { computeTarget } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  };
}

function restoreHistory(
  items: HistoryItem[],
  nextId: () => string,
  closeRunningActivities = true,
): ChatMessage[] {
  const restored: ChatMessage[] = [];
  const fallbackTs = Date.now();
  for (const item of items) {
    const timestamp = item.timestamp ?? fallbackTs;
    if (item.role === "user") {
      restored.push({
        id: nextId(),
        role: "user",
        content: item.content ?? "",
        ...(item.images && item.images.length > 0 ? { images: item.images } : {}),
        timestamp,
      });
      continue;
    }
    let message: ChatMessage = {
      id: nextId(),
      role: "assistant",
      content: "",
      timestamp,
    };
    for (const frame of item.frames ?? []) {
      message = applyFrameToMessage(message, frame, timestamp);
    }
    if (closeRunningActivities) {
      message = {
        ...message,
        activities: (message.activities ?? []).map((activity) =>
          activity.status === "running"
            ? { ...activity, status: "complete" as const }
            : activity,
        ),
      };
    }
    restored.push(message);
  }
  return restored;
}

function finishActivities(
  messages: ChatMessage[],
  status: ActivityItem["status"],
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant" &&
    message.activities?.some((activity) => activity.status === "running")
      ? {
          ...message,
          activities: message.activities.map((activity) =>
            activity.status === "running" ? { ...activity, status } : activity,
          ),
        }
      : message,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** Parse one SSE response and feed each JSON data frame to a shared consumer. */
async function consumeSse(
  response: Response,
  onFrame: (frame: AgentFrame) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim();
    if (!json) return;
    let frame: AgentFrame;
    try {
      frame = JSON.parse(json) as AgentFrame;
    } catch {
      return;
    }
    onFrame(frame);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
}

export function useAgent(projectId?: string) {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [notebookEntries, setNotebookEntries] = useState<NotebookEntry[]>([]);
  const [subagentCompletions, setSubagentCompletions] = useState(0);
  const [status, setStatus] = useState<Status>("ready");
  const [runState, setRunState] = useState<AgentRunState>("idle");
  const [pendingSteers, setPendingSteers] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const clientFetchRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // send() claims the tab synchronously BEFORE its first await: a loadSession
  // resolving mid-run must not replace the transcript.
  const sendClaimRef = useRef(false);
  const messageCounter = useRef(0);

  const nextId = useCallback(() => String(++messageCounter.current), []);

  const bindSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  const applyRunFrame = useCallback(
    (consumer: RunConsumer, frame: AgentFrame): boolean => {
      const sequence = typeof frame.seq === "number" &&
        Number.isSafeInteger(frame.seq) &&
        frame.seq >= 0
        ? frame.seq
        : null;
      if (sequence !== null) {
        if (sequence <= consumer.lastSeq) return false;
        consumer.lastSeq = sequence;
      }

      if (frame.type === "error") {
        consumer.outcome = frame.kind === "budget" ? "blocked" : "error";
        setRunState(consumer.outcome);
      } else if (frame.type === "done") {
        consumer.sawDone = true;
      } else if (frame.type === "run_start" && typeof frame.runId === "string") {
        consumer.currentRunId = frame.runId;
      }

      if (frame.type === "context_usage") {
        const usage = parseContextUsage(frame);
        if (usage) setContextUsage(usage);
      }
      const notebook = parseNotebookFrame(frame, consumer.currentRunId);
      if (notebook) {
        setNotebookEntries((previous) => mergeNotebookEntries(previous, [notebook]));
      }
      if (frame.type === "tool_end" && frame.toolName === "subagent") {
        setSubagentCompletions((count) => count + 1);
      }

      const result = applyFrameToTranscript(
        consumer.transcript,
        consumer.transcriptState,
        frame,
        nextId,
      );
      consumer.transcript = result.messages;
      consumer.transcriptState = result.state;
      if (result.steering) setPendingSteers(result.steering);
      if (frame.type !== "done") setMessages(consumer.transcript);
      return true;
    },
    [nextId],
  );

  const finalizeRun = useCallback((consumer: RunConsumer) => {
    consumer.transcript = finishActivities(consumer.transcript, "complete");
    setMessages(consumer.transcript);
    setPendingSteers([]);
    setStatus("ready");
    setRunState(consumer.outcome);
  }, []);

  const failRun = useCallback((consumer: RunConsumer, aborted: boolean) => {
    consumer.transcript = finishActivities(
      consumer.transcript,
      aborted ? "complete" : "error",
    ).map((message) =>
      message.id === consumer.transcriptState.assistantId && !aborted && !message.content
        ? { ...message, content: "Something went wrong. Please try again." }
        : message,
    );
    setMessages(consumer.transcript);
    setPendingSteers([]);
    setStatus(aborted ? "ready" : "error");
    setRunState(aborted ? "idle" : "error");
  }, []);

  const consumeRunResponse = useCallback(
    async (response: Response, consumer: RunConsumer) => {
      await consumeSse(response, (frame) => {
        if (mountedRef.current) applyRunFrame(consumer, frame);
      });
    },
    [applyRunFrame],
  );

  const restorePendingInterview = useCallback(
    async (id: string, consumer: RunConsumer, signal: AbortSignal) => {
      const alreadyPresent = consumer.transcript.some((message) =>
        message.activities?.some(
          (activity) => activity.toolName === "interview" && activity.status === "running",
        ),
      );
      if (alreadyPresent) return;
      try {
        const response = await apiFetch(
          `/sessions/${encodeURIComponent(id)}/interview`,
          { signal },
          scopedProjectId,
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          pending?: { toolCallId?: unknown; payload?: unknown } | null;
        };
        const pending = data.pending;
        if (!pending || typeof pending.toolCallId !== "string") return;
        const appearedMeanwhile = consumer.transcript.some((message) =>
          message.activities?.some((activity) => activity.id === pending.toolCallId),
        );
        if (appearedMeanwhile) return;
        applyRunFrame(consumer, {
          type: "tool_start",
          toolName: "interview",
          toolCallId: pending.toolCallId,
          args: pending.payload,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        // The run event stream remains authoritative; this endpoint is only a
        // fallback for a pending form whose original tool_start was missed.
      }
    },
    [applyRunFrame, scopedProjectId],
  );

  /**
   * Bind an untouched tab to a stored session. The run snapshot is checked
   * before history so a refresh can rebuild an in-flight transcript from its
   * baseline and attach to the sequenced replay/live stream without duplicates.
   */
  const loadSession = useCallback(
    async (id: string): Promise<boolean> => {
      if (sessionIdRef.current || sendClaimRef.current) return false;
      clientFetchRef.current?.abort();
      const controller = new AbortController();
      clientFetchRef.current = controller;
      let activeConsumer: RunConsumer | null = null;
      try {
        const stateResponse = await apiFetch(
          `/sessions/${encodeURIComponent(id)}/run/state`,
          { signal: controller.signal },
          scopedProjectId,
        );
        if (!stateResponse.ok) return false;
        const state = (await stateResponse.json()) as RunStateResponse;
        if (sessionIdRef.current || sendClaimRef.current || !mountedRef.current) return false;

        if (state.status === "none") {
          const historyResponse = await apiFetch(
            `/sessions/${encodeURIComponent(id)}/history`,
            { signal: controller.signal },
            scopedProjectId,
          );
          if (!historyResponse.ok) return false;
          const history = (await historyResponse.json()) as {
            messages?: HistoryItem[];
            contextUsage?: unknown;
          };
          if (sessionIdRef.current || sendClaimRef.current || !mountedRef.current) return false;
          bindSession(id);
          setMessages(restoreHistory(history.messages ?? [], nextId));
          setContextUsage(parseContextUsage(history.contextUsage));
          setStatus("ready");
          setRunState("idle");
          return true;
        }

        const snapshot = state.run;
        if (!snapshot) return false;
        bindSession(id);
        const transcript = restoreHistory(snapshot.baseline.messages ?? [], nextId);
        const timestamp = Date.now();
        const assistantId = nextId();
        const consumer: RunConsumer = {
          transcript: [
            ...transcript,
            {
              id: nextId(),
              role: "user",
              content: snapshot.prompt,
              ...(snapshot.images?.length ? { images: snapshot.images } : {}),
              timestamp,
            },
            { id: assistantId, role: "assistant", content: "", timestamp },
          ],
          transcriptState: { assistantId, sawPromptEcho: false },
          lastSeq: -1,
          currentRunId: snapshot.runId,
          outcome: "done",
          sawDone: false,
        };
        activeConsumer = consumer;
        setContextUsage(parseContextUsage(snapshot.baseline.contextUsage));
        setMessages(consumer.transcript);
        setStatus(state.status === "running" ? "streaming" : "ready");
        setRunState(state.status === "running" ? "running" : "done");

        for (const frame of snapshot.frames ?? []) applyRunFrame(consumer, frame);
        if (Number.isSafeInteger(snapshot.lastSeq)) {
          consumer.lastSeq = Math.max(consumer.lastSeq, snapshot.lastSeq);
        }

        if (state.status === "complete") {
          finalizeRun(consumer);
          return true;
        }

        await restorePendingInterview(id, consumer, controller.signal);
        const eventsResponse = await apiFetch(
          `/sessions/${encodeURIComponent(id)}/run/events?after=${encodeURIComponent(
            String(Math.max(0, consumer.lastSeq)),
          )}`,
          { signal: controller.signal },
          scopedProjectId,
        );
        if (!eventsResponse.ok) {
          throw new Error(`run reconnect failed: ${eventsResponse.status}`);
        }
        await consumeRunResponse(eventsResponse, consumer);
        if (clientFetchRef.current === controller && mountedRef.current) finalizeRun(consumer);
        return true;
      } catch (error) {
        if (
          clientFetchRef.current === controller &&
          mountedRef.current &&
          activeConsumer
        ) {
          failRun(activeConsumer, isAbortError(error));
        }
        return false;
      } finally {
        if (clientFetchRef.current === controller) clientFetchRef.current = null;
      }
    },
    [
      applyRunFrame,
      bindSession,
      consumeRunResponse,
      failRun,
      finalizeRun,
      nextId,
      restorePendingInterview,
      scopedProjectId,
    ],
  );

  const ensureSession = useCallback(async (signal?: AbortSignal) => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const response = await apiFetch(
      "/sessions",
      { method: "POST", signal },
      scopedProjectId,
    );
    if (!response.ok) throw new Error(`Failed to create session: ${response.status}`);
    const session = (await response.json()) as { id: string };
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    bindSession(session.id);
    return session.id;
  }, [bindSession, scopedProjectId]);

  /** Queue a message into the live run. "not_streaming" = the run ended
   * first; the caller should fall back to a normal send. */
  const steer = useCallback(
    async (text: string): Promise<"ok" | "not_streaming" | "error"> => {
      const id = sessionIdRef.current;
      if (!id) return "not_streaming";
      try {
        const response = await apiFetch(
          `/sessions/${encodeURIComponent(id)}/steer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
          },
          scopedProjectId,
        );
        if (response.ok) {
          const data = (await response.json()) as { pending?: unknown };
          if (Array.isArray(data.pending)) setPendingSteers(data.pending.map(String));
          return "ok";
        }
        return response.status === 409 ? "not_streaming" : "error";
      } catch {
        return "error";
      }
    },
    [scopedProjectId],
  );

  const send = useCallback(
    async (
      text: string,
      model?: string,
      _legacyMeta?: unknown,
      fusionConfig?: Record<string, unknown>,
      computeTarget?: string,
      thinkingLevel?: string,
      images?: PromptImage[],
    ): Promise<string | undefined> => {
      if (!text.trim() || status === "submitted" || status === "streaming") return;
      sendClaimRef.current = true;
      clientFetchRef.current?.abort();
      const controller = new AbortController();
      clientFetchRef.current = controller;

      const userMsgId = nextId();
      const assistantId = nextId();
      const timestamp = Date.now();
      const consumer: RunConsumer = {
        transcript: [
          ...messages,
          {
            id: userMsgId,
            role: "user",
            content: text,
            ...(images && images.length > 0 ? { images } : {}),
            timestamp,
          },
          { id: assistantId, role: "assistant", content: "", timestamp },
        ],
        transcriptState: { assistantId, sawPromptEcho: false },
        lastSeq: -1,
        outcome: "done",
        sawDone: false,
      };
      setMessages(consumer.transcript);
      setStatus("submitted");
      setRunState("running");

      try {
        const id = await ensureSession(controller.signal);
        const startRun = () =>
          apiFetch(
            `/sessions/${encodeURIComponent(id)}/run`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                buildRunBody({
                  message: text,
                  model,
                  fusionConfig,
                  computeTarget,
                  thinkingLevel,
                  images,
                }),
              ),
              signal: controller.signal,
            },
            scopedProjectId,
          );
        let response = await startRun();
        for (let attempt = 0; response.status === 409 && attempt < 4; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          response = await startRun();
        }
        if (!response.ok) throw new Error(`run failed: ${response.status}`);
        setStatus("streaming");
        await consumeRunResponse(response, consumer);
        if (clientFetchRef.current === controller && mountedRef.current) finalizeRun(consumer);
      } catch (error) {
        if (
          mountedRef.current &&
          clientFetchRef.current === controller
        ) {
          failRun(consumer, isAbortError(error));
        }
      } finally {
        sendClaimRef.current = false;
        if (clientFetchRef.current === controller) clientFetchRef.current = null;
      }

      return userMsgId;
    },
    [
      consumeRunResponse,
      ensureSession,
      failRun,
      finalizeRun,
      messages,
      nextId,
      scopedProjectId,
      status,
    ],
  );

  const stop = useCallback(async (): Promise<string[]> => {
    clientFetchRef.current?.abort();
    const id = sessionIdRef.current;
    let restored: string[] = [];
    if (id) {
      try {
        const response = await apiFetch(
          `/sessions/${encodeURIComponent(id)}/abort`,
          { method: "POST" },
          scopedProjectId,
        );
        if (response.ok) {
          const data = (await response.json()) as { restored?: unknown };
          if (Array.isArray(data.restored)) restored = data.restored.map(String);
        }
      } catch {
        // Server abort is best-effort; returning queued text is a bonus.
      }
    }
    setPendingSteers([]);
    setStatus("ready");
    setRunState("idle");
    return restored;
  }, [scopedProjectId]);

  const reset = useCallback(() => {
    clientFetchRef.current?.abort();
    clientFetchRef.current = null;
    setMessages([]);
    setContextUsage(null);
    setNotebookEntries([]);
    setSubagentCompletions(0);
    setPendingSteers([]);
    setStatus("ready");
    setRunState("idle");
    bindSession(null);
  }, [bindSession]);

  // Disconnecting this browser consumer must not abort the durable server run.
  // Explicit stop() is the only path that calls POST /abort.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientFetchRef.current?.abort();
    };
  }, []);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  return {
    messages,
    contextUsage,
    status,
    runState,
    sessionId,
    send,
    stop,
    reset,
    getSessionId,
    loadSession,
    steer,
    pendingSteers,
    notebookEntries,
    subagentCompletions,
  };
}
