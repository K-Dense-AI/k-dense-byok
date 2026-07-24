"use client";
import { useEffect, useRef } from "react";

/**
 * Poll the notebook while async subagent work may still land entries after
 * the run's SSE stream has ended (harvest happens server-side on completion;
 * there is no push channel). Goes dormant after `maxQuietPolls` ticks without
 * a signature change; a `resetKey` bump (new subagent dispatch / run start or
 * end) or re-enable wakes it up.
 *
 * `hasOutstandingWork` suppresses dormancy: a background subagent can run far
 * longer than the quiet budget, and going fully dormant made its entries
 * invisible until the user reloaded. Polling continues but strides out to
 * `maxIntervalMs` so a long job isn't refetched every few seconds forever.
 */
export function useNotebookPolling(opts: {
  enabled: boolean;
  refetch: () => void;
  /** Fingerprint of the fetched entries (ids joined); change resets quiet. */
  signature: string;
  resetKey: number;
  intervalMs?: number;
  maxQuietPolls?: number;
  /** True while async subagent work may still produce entries. */
  hasOutstandingWork?: boolean;
  /** Slowest cadence used once past the quiet budget. */
  maxIntervalMs?: number;
}): void {
  const {
    enabled,
    refetch,
    signature,
    resetKey,
    intervalMs = 5000,
    maxQuietPolls = 6,
    hasOutstandingWork = false,
    maxIntervalMs = 30_000,
  } = opts;
  const sigRef = useRef(signature);
  const quietRef = useRef(0);
  const ticksRef = useRef(0);
  // Read through refs so a changing callback identity doesn't restart the timer.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const outstandingRef = useRef(hasOutstandingWork);
  outstandingRef.current = hasOutstandingWork;

  useEffect(() => {
    if (signature !== sigRef.current) {
      sigRef.current = signature;
      quietRef.current = 0;
    }
  }, [signature]);

  useEffect(() => {
    if (!enabled) return;
    quietRef.current = 0;
    ticksRef.current = 0;
    const maxStride = Math.max(1, Math.round(maxIntervalMs / intervalMs));
    const timer = setInterval(() => {
      ticksRef.current++;
      const quiet = quietRef.current;
      if (quiet >= maxQuietPolls) {
        if (!outstandingRef.current) return; // dormant until reset
        // Poll every Nth tick instead, growing to maxStride.
        const stride = Math.min(maxStride, quiet - maxQuietPolls + 2);
        if (ticksRef.current % stride !== 0) return;
      }
      quietRef.current = quiet + 1;
      refetchRef.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, resetKey, intervalMs, maxQuietPolls, maxIntervalMs]);
}
