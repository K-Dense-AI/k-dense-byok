/**
 * Flatten time-sorted entries into a render list with day / run / session
 * dividers. Day dividers appear only when the set spans more than one local
 * day; run dividers appear when the (server-stamped) runId changes between
 * consecutive stamped entries; session dividers only in project scope. Pure.
 */
import type { NotebookEntry } from "./notebook";

export type TimelineItem =
  | { kind: "entry"; entry: NotebookEntry }
  | { kind: "day"; key: string; label: string }
  | { kind: "run"; key: string; runId: string }
  | { kind: "session"; key: string; sessionId: string; name: string };

export function buildTimeline(
  entries: NotebookEntry[],
  opts: {
    withSessionDividers?: boolean;
    sessionNames?: ReadonlyMap<string, string>;
  } = {},
): TimelineItem[] {
  const out: TimelineItem[] = [];
  const dayKey = (t: number) => new Date(t).toDateString();
  const multiDay = new Set(entries.map((e) => dayKey(e.timestamp))).size > 1;
  const currentYear = new Date().getFullYear();
  let prevDay: string | null = null;
  // null = no stamped entry seen yet in this section (no divider before the
  // first run); unstamped entries never reset the tracker.
  let prevRun: string | null = null;
  let prevSession: string | null = null;
  for (const e of entries) {
    if (opts.withSessionDividers && e.sessionId && e.sessionId !== prevSession) {
      out.push({
        kind: "session",
        key: `s-${e.sessionId}`,
        sessionId: e.sessionId,
        name: opts.sessionNames?.get(e.sessionId) ?? e.sessionId,
      });
      prevSession = e.sessionId;
      prevDay = null;
      prevRun = null;
    }
    if (multiDay) {
      const dk = dayKey(e.timestamp);
      if (dk !== prevDay) {
        const d = new Date(e.timestamp);
        out.push({
          kind: "day",
          key: `d-${e.sessionId ?? ""}-${dk}`,
          label: d.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            ...(d.getFullYear() !== currentYear ? { year: "numeric" } : {}),
          }),
        });
        prevDay = dk;
      }
    }
    if (e.runId) {
      if (prevRun !== null && e.runId !== prevRun) {
        out.push({ kind: "run", key: `r-${e.sessionId ?? ""}-${e.runId}`, runId: e.runId });
      }
      prevRun = e.runId;
    }
    out.push({ kind: "entry", entry: e });
  }
  return out;
}
