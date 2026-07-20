"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MODAL_CREDENTIALS_CHANGED_EVENT,
  MODAL_JOB_FINISHED_EVENT,
  MODAL_JOBS_CHANGED_EVENT,
  type ModalCatalog,
  type ModalJobDetail,
  type ModalJobStatus,
  type ModalJobsResponse,
  type ModalLogStream,
  isModalJobActive,
  isModalJobTerminal,
  parseModalCatalog,
  parseModalJob,
  parseModalJobsResponse,
  parseModalLogDelta,
} from "@/lib/modal-jobs";
import { apiFetch, useProjectScopeId } from "@/lib/projects";

const ACTIVE_LIST_POLL_MS = 1_500;
const IDLE_LIST_POLL_MS = 12_000;
const ACTIVE_DETAIL_POLL_MS = 1_000;
const ACTIVE_LOG_POLL_MS = 800;
const MAX_LOG_CHARS = 500_000;

const catalogCache = new Map<string, ModalCatalog>();

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as unknown;
  if (body && typeof body === "object") {
    const detail = (body as Record<string, unknown>).detail;
    const error = (body as Record<string, unknown>).error;
    if (typeof detail === "string" && detail) return new Error(detail);
    if (typeof error === "string" && error) return new Error(error);
  }
  return new Error(`${fallback} (${response.status})`);
}

function dispatchJobsChanged(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MODAL_JOBS_CHANGED_EVENT, { detail: { projectId } }),
  );
}

function dispatchJobFinished(
  projectId: string,
  job: ModalJobDetail,
  resultsCollected = false,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MODAL_JOB_FINISHED_EVENT, {
      detail: {
        projectId,
        jobId: job.id,
        sessionId: job.sessionId,
        status: job.status,
        resultsCollected,
      },
    }),
  );
}

export interface UseModalCatalogResult {
  catalog: ModalCatalog | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModalCatalog(projectId?: string): UseModalCatalogResult {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [catalog, setCatalog] = useState<ModalCatalog | null>(
    () => catalogCache.get(scopedProjectId) ?? null,
  );
  const [loading, setLoading] = useState(!catalog);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(
      "/modal/instances",
      { signal: controller.signal },
      scopedProjectId,
    )
      .then(async (response) => {
        if (!response.ok) throw await responseError(response, "Failed to load compute catalog");
        const body = await response.json() as unknown;
        const parsed = parseModalCatalog(body);
        const root =
          body !== null && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
        if (
          root.modalConfigured === undefined &&
          root.modal_configured === undefined &&
          root.configured === undefined
        ) {
          // Compatibility for servers from the transition period where the
          // resource catalog predated its configuration flag.
          const credentials = await apiFetch(
            "/credentials",
            { signal: controller.signal },
            scopedProjectId,
          );
          if (credentials.ok) {
            const credentialBody = await credentials.json() as Record<string, {
              set?: boolean;
            }>;
            parsed.modalConfigured = Boolean(
              credentialBody.modalTokenId?.set &&
                credentialBody.modalTokenSecret?.set,
            );
          }
        }
        catalogCache.set(scopedProjectId, parsed);
        setCatalog(parsed);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load compute catalog");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, scopedProjectId]);

  useEffect(() => {
    const onCredentialsChanged = () => refresh();
    window.addEventListener(MODAL_CREDENTIALS_CHANGED_EVENT, onCredentialsChanged);
    return () =>
      window.removeEventListener(MODAL_CREDENTIALS_CHANGED_EVENT, onCredentialsChanged);
  }, [refresh]);

  return { catalog, loading, error, refresh };
}

export interface UseModalJobsOptions {
  projectId?: string;
  sessionId?: string | null;
  status?: ModalJobStatus | null;
  limit?: number;
  enabled?: boolean;
  activePollMs?: number;
  idlePollMs?: number;
}

export interface UseModalJobsResult extends ModalJobsResponse {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  activeCount: number;
  refresh: () => void;
}

export function useModalJobs(options: UseModalJobsOptions = {}): UseModalJobsResult {
  const contextProjectId = useProjectScopeId();
  const projectId = options.projectId ?? contextProjectId;
  const {
    sessionId = null,
    status = null,
    limit = 100,
    enabled = true,
    activePollMs = ACTIVE_LIST_POLL_MS,
    idlePollMs = IDLE_LIST_POLL_MS,
  } = options;
  const [data, setData] = useState<ModalJobsResponse>({ jobs: [], groups: [] });
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const statusesRef = useRef<Map<string, ModalJobStatus> | null>(null);

  useEffect(() => {
    statusesRef.current = null;
  }, [projectId, sessionId, status]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const poll = async (initial: boolean) => {
      controller?.abort();
      controller = new AbortController();
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const query = new URLSearchParams();
        if (sessionId) query.set("sessionId", sessionId);
        if (status) {
          query.set("status", status);
          // Compatibility with early durable-compute servers.
          query.set("state", status);
        }
        query.set("limit", String(Math.max(1, Math.min(500, limit))));
        const response = await apiFetch(
          `/modal/jobs?${query.toString()}`,
          { signal: controller.signal },
          projectId,
        );
        if (!response.ok) throw await responseError(response, "Failed to load Modal jobs");
        const parsed = parseModalJobsResponse(await response.json());
        if (cancelled) return;
        setData(parsed);
        setError(null);

        const nextStatuses = new Map(parsed.jobs.map((job) => [job.id, job.status]));
        if (statusesRef.current) {
          for (const job of parsed.jobs) {
            const previous = statusesRef.current.get(job.id);
            if (
              (!previous || isModalJobActive(previous)) &&
              isModalJobTerminal(job.status)
            ) {
              dispatchJobFinished(projectId, job);
            }
          }
        }
        statusesRef.current = nextStatuses;
        const hasActive = parsed.jobs.some((job) => isModalJobActive(job.status));
        const delay = hasActive ? activePollMs : idlePollMs;
        if (delay > 0) timer = setTimeout(() => void poll(false), delay);
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load Modal jobs");
        if (idlePollMs > 0) {
          timer = setTimeout(() => void poll(false), idlePollMs);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void poll(true);
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    activePollMs,
    enabled,
    idlePollMs,
    limit,
    projectId,
    refreshKey,
    sessionId,
    status,
  ]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onChange = (event: Event) => {
      const eventProjectId = (
        event as CustomEvent<{ projectId?: string }>
      ).detail?.projectId;
      if (!eventProjectId || eventProjectId === projectId) refresh();
    };
    window.addEventListener(MODAL_JOBS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(MODAL_JOBS_CHANGED_EVENT, onChange);
  }, [enabled, projectId, refresh]);

  return {
    ...data,
    loading,
    refreshing,
    error,
    activeCount: data.jobs.filter((job) => isModalJobActive(job.status)).length,
    refresh,
  };
}

export interface UseModalJobOptions {
  projectId?: string;
  enabled?: boolean;
  activePollMs?: number;
}

export interface UseModalJobResult {
  job: ModalJobDetail | null;
  loading: boolean;
  mutating: "cancel" | "retry" | "results" | null;
  error: string | null;
  refresh: () => void;
  cancel: () => Promise<ModalJobDetail | null>;
  retry: () => Promise<ModalJobDetail | null>;
  results: () => Promise<ModalJobDetail | null>;
}

export function useModalJob(
  jobId: string | null,
  options: UseModalJobOptions = {},
): UseModalJobResult {
  const contextProjectId = useProjectScopeId();
  const projectId = options.projectId ?? contextProjectId;
  const { enabled = true, activePollMs = ACTIVE_DETAIL_POLL_MS } = options;
  const [job, setJob] = useState<ModalJobDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(jobId && enabled));
  const [mutating, setMutating] = useState<UseModalJobResult["mutating"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!jobId || !enabled) {
      setJob(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const poll = async (initial: boolean) => {
      controller?.abort();
      controller = new AbortController();
      if (initial) setLoading(true);
      try {
        const response = await apiFetch(
          `/modal/jobs/${encodeURIComponent(jobId)}`,
          { signal: controller.signal },
          projectId,
        );
        if (!response.ok) throw await responseError(response, "Failed to load Modal job");
        const parsed = parseModalJob(await response.json());
        if (!parsed) throw new Error("The Modal job response was invalid");
        if (cancelled) return;
        setJob(parsed);
        setError(null);
        if (isModalJobActive(parsed.status) && activePollMs > 0) {
          timer = setTimeout(() => void poll(false), activePollMs);
        }
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load Modal job");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll(true);
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activePollMs, enabled, jobId, projectId, refreshKey]);

  const mutate = useCallback(
    async (action: "cancel" | "retry" | "results") => {
      if (!jobId) return null;
      setMutating(action);
      setError(null);
      try {
        let response = await apiFetch(
          `/modal/jobs/${encodeURIComponent(jobId)}/${action}`,
          { method: "POST" },
          projectId,
        );
        if (
          action === "results" &&
          (response.status === 404 || response.status === 405)
        ) {
          response = await apiFetch(
            `/modal/jobs/${encodeURIComponent(jobId)}/results`,
            {},
            projectId,
          );
        }
        if (!response.ok) throw await responseError(response, `Failed to ${action} Modal job`);
        const body = await response.json().catch(() => null);
        const parsed = parseModalJob(body);
        if (parsed) setJob(parsed);
        dispatchJobsChanged(projectId);
        if (action === "results" && parsed) {
          dispatchJobFinished(projectId, parsed, true);
        }
        refresh();
        return parsed;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Failed to ${action} Modal job`);
        return null;
      } finally {
        setMutating(null);
      }
    },
    [jobId, projectId, refresh],
  );
  const cancel = useCallback(() => mutate("cancel"), [mutate]);
  const retry = useCallback(() => mutate("retry"), [mutate]);
  const results = useCallback(() => mutate("results"), [mutate]);

  return {
    job,
    loading,
    mutating,
    error,
    refresh,
    cancel,
    retry,
    results,
  };
}

export interface UseModalJobLogsOptions {
  projectId?: string;
  enabled?: boolean;
  active?: boolean;
  pollMs?: number;
}

export interface UseModalJobLogsResult {
  content: string;
  cursor: number;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  complete: boolean;
  refresh: () => void;
}

export function useModalJobLogs(
  jobId: string | null,
  stream: ModalLogStream,
  options: UseModalJobLogsOptions = {},
): UseModalJobLogsResult {
  const contextProjectId = useProjectScopeId();
  const projectId = options.projectId ?? contextProjectId;
  const {
    enabled = true,
    active = true,
    pollMs = ACTIVE_LOG_POLL_MS,
  } = options;
  const [content, setContent] = useState("");
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [loading, setLoading] = useState(Boolean(jobId && enabled));
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [complete, setComplete] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    cursorRef.current = 0;
    setCursor(0);
    setContent("");
    setTruncated(false);
    setComplete(false);
  }, [jobId, stream]);

  useEffect(() => {
    if (!jobId || !enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const poll = async (initial: boolean) => {
      controller?.abort();
      controller = new AbortController();
      if (initial) setLoading(true);
      const after = cursorRef.current;
      try {
        const query = new URLSearchParams({
          stream,
          after: String(after),
          // Compatibility with early durable-compute servers.
          cursor: String(after),
        });
        const response = await apiFetch(
          `/modal/jobs/${encodeURIComponent(jobId)}/logs?${query.toString()}`,
          { signal: controller.signal },
          projectId,
        );
        if (!response.ok) throw await responseError(response, "Failed to load Modal logs");
        const delta = parseModalLogDelta(await response.json(), stream, after);
        if (cancelled) return;
        cursorRef.current = delta.cursor;
        setCursor(delta.cursor);
        setTruncated((value) => value || delta.truncated);
        setComplete(delta.complete);
        if (delta.delta) {
          setContent((current) => {
            const next = delta.truncated ? delta.delta : current + delta.delta;
            return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
          });
        }
        setError(null);
        if (active && !delta.complete && pollMs > 0) {
          timer = setTimeout(() => void poll(false), pollMs);
        }
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load Modal logs");
        if (active && pollMs > 0) {
          timer = setTimeout(() => void poll(false), Math.max(pollMs, 3_000));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll(true);
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, enabled, jobId, pollMs, projectId, refreshKey, stream]);

  return { content, cursor, loading, error, truncated, complete, refresh };
}
