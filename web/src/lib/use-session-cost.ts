"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/projects";

export interface CostEntry {
  entryId: string;
  ts: number;
  sessionId: string;
  role: "agent" | "subagent" | "compute" | string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  totalTokens: number;
  agentUsd: number;
  subagentUsd: number;
  computeUsd: number;
  entries: CostEntry[];
}

const EMPTY: SessionCostSummary = {
  sessionId: "",
  totalUsd: 0,
  totalTokens: 0,
  agentUsd: 0,
  subagentUsd: 0,
  computeUsd: 0,
  entries: [],
};

/**
 * Fetches the cost ledger for a session.
 *
 * `refreshKey` is a monotonic counter — bump it whenever a turn completes so
 * the summary refetches. The Pi backend writes final costs synchronously, so a
 * single fetch per `refreshKey` is sufficient (no pending-poll loop).
 */
export function useSessionCost(
  sessionId: string | null | undefined,
  refreshKey: number,
): { summary: SessionCostSummary; loading: boolean } {
  const [summary, setSummary] = useState<SessionCostSummary>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setSummary(EMPTY);
      return;
    }
    let cancelled = false;

    const fetchOnce = async () => {
      setLoading(true);
      try {
        const r = await apiFetch(
          `/sessions/${encodeURIComponent(sessionId)}/costs`,
        );
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data || typeof data !== "object") return;
        setSummary({ ...EMPTY, ...data });
      } catch {
        // swallow -- next refreshKey bump will retry
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOnce();

    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return { summary, loading };
}
