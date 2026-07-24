"use client";

import { useEffect, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";

export type BudgetState = "ok" | "warn" | "exceeded";

export interface ProjectBudgetStatus {
  /** What the cap is measured against: ledgered + reserved + in-flight. */
  totalUsd: number;
  /** Money already ledgered. */
  spentUsd?: number;
  /** Held for admitted-but-unfinished compute jobs. */
  reservedUsd?: number;
  /** Accrued by runs that haven't been ledgered yet. */
  inFlightUsd?: number;
  committedUsd?: number;
  limitUsd: number | null;
  ratio: number | null;
  state: BudgetState;
}

export interface ProjectCostSummary {
  projectId: string;
  totalUsd: number;
  spentUsd?: number;
  reservedUsd?: number;
  inFlightUsd?: number;
  committedUsd?: number;
  listPriceUsd?: number;
  subscriptionTokens?: number;
  totalTokens: number;
  sessionCount: number;
  limitUsd: number | null;
  budget: ProjectBudgetStatus;
}

function emptySummary(projectId: string): ProjectCostSummary {
  return {
    projectId,
    totalUsd: 0,
    spentUsd: 0,
    reservedUsd: 0,
    inFlightUsd: 0,
    committedUsd: 0,
    listPriceUsd: 0,
    subscriptionTokens: 0,
    totalTokens: 0,
    sessionCount: 0,
    limitUsd: null,
    budget: {
      totalUsd: 0,
      spentUsd: 0,
      reservedUsd: 0,
      inFlightUsd: 0,
      committedUsd: 0,
      limitUsd: null,
      ratio: null,
      state: "ok",
    },
  };
}

/**
 * Fetches the cumulative cost across every session in the currently-active
 * project. ``refreshKey`` is a monotonic counter bumped whenever a turn
 * completes (see page.tsx) so the header pill reflects the latest totals.
 *
 * Also subscribes to project-change events so switching projects reloads the
 * totals. The Pi backend reports final costs synchronously, so a single fetch
 * per refresh is sufficient.
 */
export function useProjectCost(
  refreshKey: number,
  projectId?: string,
): { summary: ProjectCostSummary; loading: boolean } {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [summary, setSummary] = useState<ProjectCostSummary>(() =>
    emptySummary(scopedProjectId),
  );
  const [loading, setLoading] = useState(false);

  // Clearing on every refreshKey bump made the header pill blink back to $0.00
  // after each turn; only a project switch invalidates the numbers.
  useEffect(() => {
    setSummary(emptySummary(scopedProjectId));
  }, [scopedProjectId]);

  useEffect(() => {
    if (!scopedProjectId) return;
    let cancelled = false;

    const fetchOnce = async () => {
      setLoading(true);
      try {
        const r = await apiFetch(
          `/projects/${encodeURIComponent(scopedProjectId)}/costs`,
          {},
          scopedProjectId,
        );
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data || typeof data !== "object") return;
        setSummary({ ...emptySummary(scopedProjectId), ...data });
      } catch {
        // swallow -- next refreshKey bump or project change will retry
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOnce();

    return () => {
      cancelled = true;
    };
  }, [scopedProjectId, refreshKey]);

  return { summary, loading };
}
