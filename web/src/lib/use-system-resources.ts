"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/projects";

export interface SystemResources {
  ts: number;
  cpu: { systemPct: number; processPct: number; cores: number };
  memory: { totalBytes: number; usedBytes: number; processRssBytes: number };
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  gpu: {
    name: string;
    utilizationPct: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
  } | null;
}

const POLL_MS = 3000;
const HIDDEN_MS = 20000;

/**
 * Polls the backend's host-resource snapshot for the header monitor. Backs
 * off while the tab is hidden and catches up immediately on return. Returns
 * null until the first successful fetch (the widget hides itself).
 */
export function useSystemResources(): SystemResources | null {
  const [stats, setStats] = useState<SystemResources | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const fetchOnce = async () => {
      try {
        const r = await apiFetch("/system/resources");
        if (!r.ok) return;
        const data = (await r.json()) as SystemResources;
        if (!cancelled && data && typeof data === "object" && data.cpu) {
          setStats(data);
        }
      } catch {
        // backend briefly unreachable -- keep the last reading
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, HIDDEN_MS);
        return;
      }
      await fetchOnce();
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") fetchOnce();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return stats;
}
