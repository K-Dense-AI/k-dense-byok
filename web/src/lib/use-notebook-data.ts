"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./projects";
import { normalizeNotebookEntries, type NotebookEntry } from "./notebook";

/** Race-safe resource scoped by BOTH project and URL, including active-tab switches. */
export function useNotebookData(opts: {
  projectId: string;
  url: string | null;
  revision: string;
  poll: boolean;
  active: boolean;
}) {
  const { projectId, url, revision, poll, active } = opts;
  const key = JSON.stringify([projectId, url]);
  const [state, setState] = useState<{ key: string; entries: NotebookEntry[]; error: boolean; loaded: boolean }>({ key: "", entries: [], error: false, loaded: false });
  const generation = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    const version = ++generation.current;
    if (!url) { refreshRef.current = () => {}; return; }
    const controller = new AbortController();
    let running = false;
    let queued = false;
    const valid = () => !controller.signal.aborted && version === generation.current;
    const fetchEntries = async () => {
      if (running) { queued = true; return; }
      running = true;
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 15_000);
      try {
        const response = await apiFetch(url, { signal: request.signal, cache: "no-store" }, projectId);
        if (!response.ok) throw new Error(`Notebook fetch failed: ${response.status}`);
        const data = await response.json() as { entries?: NotebookEntry[] };
        if (!Array.isArray(data.entries)) throw new Error("Invalid notebook response");
        if (valid()) setState({ key, entries: normalizeNotebookEntries(data.entries), error: false, loaded: true });
      } catch {
        if (valid()) setState((previous) => ({ key, entries: previous.key === key ? previous.entries : [], loaded: previous.key === key && previous.loaded, error: true }));
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        running = false;
        if (valid() && queued) { queued = false; void fetchEntries(); }
      }
    };
    refreshRef.current = () => { void fetchEntries(); };
    void fetchEntries();
    const onFocus = () => { if (!document.hidden) void fetchEntries(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [projectId, url, key, revision]);
  useEffect(() => {
    if (!poll || !url) return;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, active ? 5000 : 30_000);
    return () => clearInterval(timer);
  }, [poll, url, active, refresh]);
  // Old-project contents are never exposed for even a render while effects run.
  return {
    entries: state.key === key ? state.entries : [],
    error: state.key === key && state.error,
    loaded: state.key === key && state.loaded,
    refresh,
  };
}
