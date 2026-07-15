"use client";

import { useEffect, useState } from "react";

import {
  sameProjectActivity,
  type ProjectActivitySummary,
} from "@/lib/project-activity";
import { listProjectActivities } from "@/lib/projects";

export const PROJECT_ACTIVITY_POLL_MS = 3_000;

function sameActivityMap(
  current: Readonly<Record<string, ProjectActivitySummary>>,
  next: Readonly<Record<string, ProjectActivitySummary>>,
): boolean {
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  return (
    currentIds.length === nextIds.length &&
    nextIds.every((id) => sameProjectActivity(current[id], next[id]))
  );
}

export function useProjectActivities(enabled: boolean) {
  const [activities, setActivities] = useState<
    Record<string, ProjectActivitySummary>
  >({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await listProjectActivities();
        if (!cancelled) {
          setActivities((current) => sameActivityMap(current, next) ? current : next);
        }
      } catch {
        // Status badges are advisory; project loading and navigation must keep
        // working if this lightweight background request temporarily fails.
      } finally {
        if (!cancelled) timer = setTimeout(tick, PROJECT_ACTIVITY_POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);

  return activities;
}
