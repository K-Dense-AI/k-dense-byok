"use client";

import { useEffect, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";

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
  provider?: string;
  authType?: "api_key" | "oauth" | "local" | "none";
  billingMode?: "payg" | "metered_oauth" | "subscription" | "local" | "compute";
  listPriceUsd?: number;
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  listPriceUsd?: number;
  subscriptionTokens?: number;
  totalTokens: number;
  agentUsd: number;
  subagentUsd: number;
  computeUsd: number;
  entries: CostEntry[];
}

const EMPTY: SessionCostSummary = {
  sessionId: "",
  totalUsd: 0,
  listPriceUsd: 0,
  subscriptionTokens: 0,
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
  projectId?: string,
): { summary: SessionCostSummary; loading: boolean } {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
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
          {},
          scopedProjectId,
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
  }, [sessionId, refreshKey, scopedProjectId]);

  return { summary, loading };
}
