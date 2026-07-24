"use client";

import { useEffect, useState } from "react";

import type { SessionLoadOutcome } from "@/lib/use-agent";

/**
 * Reopen the stored session a chat tab was mounted with.
 *
 * Only the mount-time id is ever restored. A tab's `sessionId` also changes
 * when the tab starts its own session, and loading *that* would run against an
 * already-bound agent — which reports a failed load, and treating that as "the
 * conversation is gone" unbinds a live session and warns the user for nothing.
 */
export function useSessionRestore({
  sessionId,
  loadSession,
  onUnavailable,
}: {
  /** Stored session for this tab, or null for a fresh tab. */
  sessionId: string | null;
  loadSession: (id: string) => Promise<SessionLoadOutcome>;
  /** Called when the backend no longer serves the stored session. */
  onUnavailable: (id: string) => void;
}): boolean {
  const [target] = useState(sessionId);
  const [ready, setReady] = useState(!target);

  useEffect(() => {
    if (!target) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void loadSession(target).then((outcome) => {
      if (cancelled) return;
      setReady(true);
      if (outcome === "gone") onUnavailable(target);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSession, onUnavailable, target]);

  return ready;
}
