"use client";

/**
 * Project "Automation" tab: pi-subagents durable schedules (recurring or
 * one-shot specialist runs that fire from Kady's resident session, even with
 * no chat tab open) and missions (durable records of delegated work).
 * Schedules are created conversationally ("run the QC pipeline every 6h");
 * this panel shows and controls them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FlagIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  closeMission,
  describeTrigger,
  getMissions,
  getSchedules,
  scheduleAction,
  type MissionView,
  type ScheduleAction,
  type ScheduleView,
} from "@/lib/automation";
import { cn, formatUsd } from "@/lib/utils";

const POLL_MS = 10_000;

const RUN_STATE_LABEL: Record<ScheduleView["runs"][number]["state"], string> = {
  running: "running",
  skipped: "skipped (overlap)",
  missed: "missed",
  completed: "completed",
  failed_launch: "failed to launch",
  failed_run: "failed",
};

export function AutomationPanel({ projectId }: { projectId: string }) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [heldByBudget, setHeldByBudget] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { confirm, dialog } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([getSchedules(projectId), getMissions(projectId)]);
      setSchedules(s.schedules);
      setHeldByBudget(s.heldByBudget);
      setMissions(m);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load automation");
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    async (schedule: ScheduleView, action: ScheduleAction) => {
      if (action === "delete") {
        const ok = await confirm({
          title: `Delete schedule "${schedule.name}"?`,
          description: "Its definition and run history are removed. Runs already in progress finish normally.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!ok) return;
      }
      setBusy(`${action}:${schedule.id}`);
      setError(null);
      try {
        setSchedules(await scheduleAction(schedule.id, action, projectId));
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : `Could not ${action} the schedule`);
      } finally {
        setBusy(null);
      }
    },
    [confirm, projectId],
  );

  const close = useCallback(
    async (mission: MissionView) => {
      const ok = await confirm({
        title: `Close mission "${mission.title}"?`,
        description: "Marks it cancelled. Linked runs are not stopped.",
        confirmLabel: "Close mission",
      });
      if (!ok) return;
      setBusy(`close:${mission.id}`);
      try {
        setMissions(await closeMission(mission.id, projectId));
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Could not close the mission");
      } finally {
        setBusy(null);
      }
    },
    [confirm, projectId],
  );

  const openMissions = useMemo(() => missions.filter((m) => !["completed", "failed", "cancelled"].includes(m.status)), [missions]);
  const closedMissions = useMemo(() => missions.filter((m) => ["completed", "failed", "cancelled"].includes(m.status)), [missions]);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4" data-testid="automation-panel">
      {dialog}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Automation</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Recurring and one-shot specialist runs, plus durable missions. Ask Kady to create one
            (&ldquo;re-run the QC report every 6 hours&rdquo;); they fire from a resident session even with no
            chat open and pause automatically when the project spend limit is reached.
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void refresh()} aria-label="Refresh automation">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {heldByBudget.length > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          {heldByBudget.length} schedule{heldByBudget.length === 1 ? " is" : "s are"} held because the project
          reached its spend limit. Raise the limit in project settings and they resume on their own.
        </p>
      )}

      <section aria-label="Schedules" className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <AlarmClockIcon className="size-3.5" /> Schedules
        </h4>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : schedules.length === 0 ? (
          <p className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
            No schedules yet. In a chat: &ldquo;every night at 2am, have the data validator re-check user_data
            and log a notebook entry&rdquo;.
          </p>
        ) : (
          schedules.map((s) => {
            const expanded = open[s.id] ?? false;
            const rowBusy = busy?.endsWith(`:${s.id}`) ?? false;
            return (
              <div key={s.id} className="rounded-lg border" data-schedule={s.id}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [s.id]: !expanded }))}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${s.name}`}
                  >
                    {expanded ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                        <span>{s.name}</span>
                        {s.heldByBudget ? (
                          <Badge variant="outline" className="h-5 text-[10px] text-amber-600">Held: spend limit</Badge>
                        ) : s.paused ? (
                          <Badge variant="outline" className="h-5 text-[10px]">Paused</Badge>
                        ) : s.activeRunId ? (
                          <Badge variant="secondary" className="h-5 text-[10px]">Running</Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {describeTrigger(s.trigger)}
                        {s.lastRun ? ` · last ${RUN_STATE_LABEL[s.lastRun.state]}` : ""}
                        {s.spendUsd > 0 ? ` · ${formatUsd(s.spendUsd)} spent` : ""}
                      </div>
                    </div>
                  </button>
                  <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Run ${s.name} now`} disabled={rowBusy} onClick={() => void act(s, "run")}>
                    {busy === `run:${s.id}` ? <Loader2Icon className="size-3.5 animate-spin" /> : <ZapIcon className="size-3.5" />}
                  </Button>
                  {s.paused ? (
                    <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Resume ${s.name}`} disabled={rowBusy || s.heldByBudget} onClick={() => void act(s, "resume")}>
                      <PlayIcon className="size-3.5" />
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Pause ${s.name}`} disabled={rowBusy} onClick={() => void act(s, "pause")}>
                      <PauseIcon className="size-3.5" />
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" aria-label={`Delete ${s.name}`} disabled={rowBusy} onClick={() => void act(s, "delete")}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                {expanded && (
                  <div className="border-t px-3 py-2 text-[11px]">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">{s.workflowScript}</pre>
                    <div className="mt-2 text-muted-foreground">
                      catch-up: {s.catchUp}
                      {s.timeoutMs ? ` · timeout ${Math.round(s.timeoutMs / 60000)} min` : ""}
                      {s.baseRef ? ` · base ${s.baseRef}` : ""}
                    </div>
                    {s.runs.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-0.5">
                        {s.runs.map((r) => (
                          <li key={r.id} className={cn("flex flex-wrap items-center gap-2", r.state.startsWith("failed") && "text-destructive")}>
                            <span className="font-mono text-[10px] text-muted-foreground">{new Date(r.plannedAt).toLocaleString()}</span>
                            <span>{RUN_STATE_LABEL[r.state]}</span>
                            <span className="text-muted-foreground">({r.dueReason})</span>
                            {r.error && <span className="truncate">{r.error}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <section aria-label="Missions" className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FlagIcon className="size-3.5" /> Missions
        </h4>
        {loaded && missions.length === 0 && (
          <p className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
            No missions recorded. Multi-step delegations Kady runs create one automatically; they survive
            restarts and hold decisions, artifacts and receipts.
          </p>
        )}
        {[...openMissions, ...closedMissions].map((m) => (
          <div key={m.id} className={cn("rounded-lg border px-3 py-2", ["completed", "failed", "cancelled"].includes(m.status) && "opacity-70")} data-mission={m.id}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                  <span>{m.title}</span>
                  <Badge variant={m.status === "needs_decision" ? "destructive" : "outline"} className="h-5 text-[10px]">{m.status.replace("_", " ")}</Badge>
                  {m.goal && <Badge variant="secondary" className="h-5 text-[10px]">goal · {m.goal.status}</Badge>}
                </div>
                {m.objective && <div className="truncate text-[11px] text-muted-foreground">{m.objective}</div>}
                <div className="text-[10px] text-muted-foreground">
                  {m.runs.length} run{m.runs.length === 1 ? "" : "s"}
                  {m.decisions.some((d) => d.status === "open") ? ` · ${m.decisions.filter((d) => d.status === "open").length} open decision(s)` : ""}
                  {m.usage?.tokens ? ` · ${m.usage.tokens.toLocaleString()} tokens` : ""}
                  {m.budget?.tokens ? ` / ${m.budget.tokens.toLocaleString()} budget` : ""}
                  {` · updated ${new Date(m.updatedAt).toLocaleString()}`}
                </div>
              </div>
              {!["completed", "failed", "cancelled"].includes(m.status) && (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" aria-label={`Close mission ${m.title}`} disabled={busy === `close:${m.id}`} onClick={() => void close(m)}>
                  Close
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
