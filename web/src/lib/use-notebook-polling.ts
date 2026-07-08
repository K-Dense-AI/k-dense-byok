"use client";
import { useEffect, useRef } from "react";

/**
 * Poll the notebook while async subagent work may still land entries after
 * the run's SSE stream has ended (harvest happens server-side on completion;
 * there is no push channel). Goes dormant after `maxQuietPolls` ticks without
 * a signature change; a `resetKey` bump (new subagent dispatch / run start or
 * end) or re-enable wakes it up.
 */
export function useNotebookPolling(opts: {
  enabled: boolean;
  refetch: () => void;
  /** Fingerprint of the fetched entries (ids joined); change resets quiet. */
  signature: string;
  resetKey: number;
  intervalMs?: number;
  maxQuietPolls?: number;
}): void {
  const { enabled, refetch, signature, resetKey, intervalMs = 5000, maxQuietPolls = 6 } = opts;
  const sigRef = useRef(signature);
  const quietRef = useRef(0);

  useEffect(() => {
    if (signature !== sigRef.current) {
      sigRef.current = signature;
      quietRef.current = 0;
    }
  }, [signature]);

  useEffect(() => {
    if (!enabled) return;
    quietRef.current = 0;
    const timer = setInterval(() => {
      if (quietRef.current >= maxQuietPolls) return; // dormant until reset
      quietRef.current++;
      refetch();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, resetKey, intervalMs, maxQuietPolls, refetch]);
}
