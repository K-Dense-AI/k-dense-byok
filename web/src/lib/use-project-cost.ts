"use client";

import { useEffect, useState } from "react";

import { apiFetch, getActiveProjectId, onProjectChange } from "@/lib/projects";

export type BudgetState = "ok" | "warn" | "exceeded";

export interface ProjectBudgetStatus {
  totalUsd: number;
  limitUsd: number | null;
  ratio: number | null;
  state: BudgetState;
}

export interface ProjectCostSummary {
  projectId: string;
  totalUsd: number;
  totalTokens: number;
  sessionCount: number;
  limitUsd: number | null;
  budget: ProjectBudgetStatus;
}

function emptySummary(projectId: string): ProjectCostSummary {
  return {
    projectId,
    totalUsd: 0,
    totalTokens: 0,
    sessionCount: 0,
    limitUsd: null,
    budget: { totalUsd: 0, limitUsd: null, ratio: null, state: "ok" },
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
): { summary: ProjectCostSummary; loading: boolean } {
  const [projectId, setProjectId] = useState<string>(() => getActiveProjectId());
  const [summary, setSummary] = useState<ProjectCostSummary>(() =>
    emptySummary(getActiveProjectId()),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    return onProjectChange((id) => {
      setProjectId(id);
      setSummary(emptySummary(id));
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    const fetchOnce = async () => {
      setLoading(true);
      try {
        const r = await apiFetch(
          `/projects/${encodeURIComponent(projectId)}/costs`,
        );
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data || typeof data !== "object") return;
        setSummary({ ...emptySummary(projectId), ...data });
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
  }, [projectId, refreshKey]);

  return { summary, loading };
}
