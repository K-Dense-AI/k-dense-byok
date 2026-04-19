"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/projects";

export interface CostEntry {
  ts: number;
  sessionId: string;
  turnId: string;
  role: "orchestrator" | "expert" | string;
  delegationId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  entryId?: string;
  costPending?: boolean;
}

export interface CostTurnBucket {
  turnId: string;
  totalUsd: number;
  orchestratorUsd: number;
  expertUsd: number;
  totalTokens: number;
  entries: CostEntry[];
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  orchestratorUsd: number;
  expertUsd: number;
  totalTokens: number;
  orchestratorTokens: number;
  expertTokens: number;
  entries: CostEntry[];
  byTurn: Record<string, CostTurnBucket>;
}

const EMPTY: SessionCostSummary = {
  sessionId: "",
  totalUsd: 0,
  orchestratorUsd: 0,
  expertUsd: 0,
  totalTokens: 0,
  orchestratorTokens: 0,
  expertTokens: 0,
  entries: [],
  byTurn: {},
};

/**
 * Fetches the OpenRouter cost ledger for a session.
 *
 * `refreshKey` is a monotonic counter — bump it whenever a turn completes so
 * the summary refetches. We also keep polling on a short interval whenever
 * any entry still has ``costPending: true`` (the backend writes the row
 * immediately with ``$0`` and backfills the OpenRouter ``/generation``
 * cost asynchronously, which can lag the stream close by a few seconds up
 * to ~60s).
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
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async (isPoll: boolean) => {
      if (!isPoll) setLoading(true);
      try {
        const r = await apiFetch(
          `/sessions/${encodeURIComponent(sessionId)}/costs`,
        );
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data || typeof data !== "object") return;
        const next: SessionCostSummary = { ...EMPTY, ...data };
        setSummary(next);
        const hasPending = (next.entries ?? []).some(
          (e) => e.costPending === true,
        );
        if (hasPending && !cancelled) {
          pollTimer = setTimeout(() => fetchOnce(true), 2000);
        }
      } catch {
        // swallow -- next refreshKey bump will retry
      } finally {
        if (!cancelled && !isPoll) setLoading(false);
      }
    };

    fetchOnce(false);

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [sessionId, refreshKey]);

  return { summary, loading };
}
