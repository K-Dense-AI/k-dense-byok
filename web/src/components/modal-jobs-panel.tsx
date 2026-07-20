"use client";

import {
  AlertTriangleIcon,
  BoxesIcon,
  Clock3Icon,
  FilterIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  ServerCogIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ModalJobDetail, ModalJobStatusBadge } from "@/components/modal-job-detail";
import {
  MODAL_JOB_STATUSES,
  type ModalComputeScope,
  type ModalJobGroup,
  type ModalJobStatus,
  type ModalJobSummary,
  formatModalDuration,
  formatModalResource,
  formatModalTimestamp,
} from "@/lib/modal-jobs";
import { useModalCatalog, useModalJobs } from "@/lib/use-modal-jobs";
import { cn, formatUsd } from "@/lib/utils";

type StatusFilter = ModalJobStatus | "all";

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: ModalJobSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40",
        selected && "bg-muted/60",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={job.id}>
          {job.id}
        </code>
        <ModalJobStatusBadge status={job.status} />
      </span>
      <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <ServerCogIcon className="size-3 shrink-0 text-violet-500" />
        <span className="min-w-0 flex-1 truncate">
          {formatModalResource(job.resolvedResource ?? job.requestedResource)}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatModalDuration(job.startedAt, job.finishedAt)}
        </span>
      </span>
      <span className="mt-1 flex min-w-0 items-center text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {job.agent ?? job.source ?? "Modal compute"}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatUsd(job.committedEstimatedUsd)} est.
        </span>
      </span>
      {job.error ? (
        <span className="mt-1 block truncate text-[10px] text-destructive" title={job.error}>
          {job.error}
        </span>
      ) : null}
    </button>
  );
}

function JobGroupSection({
  group,
  jobs,
  selectedJobId,
  onSelectJob,
}: {
  group: ModalJobGroup | null;
  jobs: ModalJobSummary[];
  selectedJobId: string | null;
  onSelectJob: (id: string) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label={group?.label ?? (group ? `Group ${group.id}` : "Individual jobs")}>
      {group ? (
        <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b bg-background/95 px-3 py-1.5 backdrop-blur">
          <BoxesIcon className="size-3 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold">
            {group.label ?? group.id}
          </span>
          <span className="text-[9px] text-muted-foreground">
            {jobs.length} job{jobs.length === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      <div>
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            selected={job.id === selectedJobId}
            onSelect={() => onSelectJob(job.id)}
          />
        ))}
      </div>
    </section>
  );
}

export interface ModalJobsPanelProps {
  projectId?: string;
  sessionId: string | null;
  scope: ModalComputeScope;
  onScopeChange: (scope: ModalComputeScope) => void;
  focusJob?: { id: string; token: number } | null;
  onOpenOutput?: (path: string) => void;
}

export function ModalJobsPanel({
  projectId,
  sessionId,
  scope,
  onScopeChange,
  focusJob,
  onOpenOutput,
}: ModalJobsPanelProps) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selection, setSelection] = useState<{
    id: string | null;
    handledFocusToken: number | null;
  }>(
    () => ({
      id: focusJob?.id ?? null,
      handledFocusToken: focusJob?.token ?? null,
    }),
  );
  const selectedJobId =
    focusJob && focusJob.token !== selection.handledFocusToken
      ? focusJob.id
      : selection.id;
  const setSelectedJobId = useCallback(
    (id: string | null) =>
      setSelection({
        id,
        handledFocusToken: focusJob?.token ?? null,
      }),
    [focusJob?.token],
  );
  const effectiveScope: ModalComputeScope =
    scope === "session" && sessionId ? "session" : "project";
  const { catalog } = useModalCatalog(projectId);
  const {
    jobs,
    groups,
    loading,
    refreshing,
    error,
    activeCount,
    refresh,
  } = useModalJobs({
    projectId,
    sessionId: effectiveScope === "session" ? sessionId : null,
    status: status === "all" ? null : status,
    limit: 200,
  });

  const grouped = useMemo(() => {
    const jobsByGroup = new Map<string, ModalJobSummary[]>();
    const ungrouped: ModalJobSummary[] = [];
    for (const job of jobs) {
      if (!job.groupId) {
        ungrouped.push(job);
        continue;
      }
      const list = jobsByGroup.get(job.groupId) ?? [];
      list.push(job);
      jobsByGroup.set(job.groupId, list);
    }
    const known = groups
      .map((group) => ({ group, jobs: jobsByGroup.get(group.id) ?? [] }))
      .filter((item) => item.jobs.length > 0);
    const knownIds = new Set(groups.map((group) => group.id));
    for (const [id, groupedJobs] of jobsByGroup) {
      if (knownIds.has(id)) continue;
      known.push({
        group: {
          id,
          label: null,
          status: null,
          jobIds: groupedJobs.map((job) => job.id),
          createdAt: groupedJobs[0]?.createdAt ?? null,
          raw: {},
        },
        jobs: groupedJobs,
      });
    }
    return { known, ungrouped };
  }, [groups, jobs]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ServerCogIcon className="size-4 text-violet-500" />
          <div>
            <h1 className="text-xs font-semibold">Modal Compute</h1>
            <p className="text-[10px] text-muted-foreground">
              Durable project jobs and estimated costs
            </p>
          </div>
        </div>
        {activeCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-1 text-[10px] font-medium text-violet-700 dark:text-violet-300">
            <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
            {activeCount} active
          </span>
        ) : null}
        <div
          role="group"
          aria-label="Job scope"
          className="ml-auto flex items-center rounded-md border bg-muted/20 p-0.5"
        >
          <button
            type="button"
            aria-pressed={effectiveScope === "project"}
            onClick={() => onScopeChange("project")}
            className={cn(
              "rounded px-2 py-1 text-[10px] font-medium",
              effectiveScope === "project"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Project
          </button>
          <button
            type="button"
            aria-pressed={effectiveScope === "session"}
            disabled={!sessionId}
            onClick={() => onScopeChange("session")}
            className={cn(
              "rounded px-2 py-1 text-[10px] font-medium disabled:opacity-40",
              effectiveScope === "session"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            This chat
          </button>
        </div>
      </header>

      {!catalog?.modalConfigured ? (
        <div className="shrink-0 border-b bg-amber-500/5 px-4 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          Modal is not connected. Existing job history remains available; connect a token pair in
          Settings → API keys to submit or retry jobs.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-80",
            selectedJobId ? "hidden" : "flex",
          )}
          aria-label="Modal jobs"
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <FilterIcon className="size-3.5 text-muted-foreground" />
            <label htmlFor="modal-status-filter" className="sr-only">
              Filter jobs by status
            </label>
            <select
              id="modal-status-filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-[11px]"
            >
              <option value="all">All statuses</option>
              {MODAL_JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Refresh jobs"
            >
              <RefreshCcwIcon
                className={cn("size-3.5", (loading || refreshing) && "animate-spin")}
              />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <div role="alert" className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <div className="flex items-start gap-2">
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              </div>
            ) : null}
            {loading && jobs.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading jobs…
              </div>
            ) : null}
            {!loading && jobs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <FolderOpenIcon className="size-7 text-muted-foreground/40" />
                <p className="text-xs font-medium">No Modal jobs</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {effectiveScope === "session"
                    ? "This chat has not submitted a durable compute job."
                    : status === "all"
                      ? "Jobs submitted by chats and specialists will appear here."
                      : `No ${status} jobs match this filter.`}
                </p>
              </div>
            ) : null}
            {grouped.known.map(({ group, jobs: groupJobs }) => (
              <JobGroupSection
                key={group.id}
                group={group}
                jobs={groupJobs}
                selectedJobId={selectedJobId}
                onSelectJob={setSelectedJobId}
              />
            ))}
            <JobGroupSection
              group={null}
              jobs={grouped.ungrouped}
              selectedJobId={selectedJobId}
              onSelectJob={setSelectedJobId}
            />
          </div>

          {jobs.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5 border-t px-3 py-2 text-[9px] text-muted-foreground">
              <Clock3Icon className="size-3" />
              {jobs.length} job{jobs.length === 1 ? "" : "s"} · last updated{" "}
              {formatModalTimestamp(new Date().toISOString())}
            </div>
          ) : null}
        </aside>

        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            selectedJobId ? "block" : "hidden md:block",
          )}
          aria-label="Modal job detail"
        >
          {selectedJobId ? (
            <ModalJobDetail
              jobId={selectedJobId}
              projectId={projectId}
              onBack={() => setSelectedJobId(null)}
              onSelectJob={setSelectedJobId}
              onOpenOutput={onOpenOutput}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-violet-500/10">
                <ServerCogIcon className="size-6 text-violet-500" />
              </div>
              <div>
                <p className="text-sm font-medium">Select a compute job</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Inspect lifecycle, requested and resolved resources, live logs, estimated costs,
                  transfers, and output artifacts.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
