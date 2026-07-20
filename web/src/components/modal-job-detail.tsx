"use client";

import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BanIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CopyIcon,
  DownloadCloudIcon,
  ExternalLinkIcon,
  FileOutputIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  ServerCogIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  type ModalJobResource,
  type ModalJobStatus,
  type ModalTransferEntry,
  formatModalBytes,
  formatModalDuration,
  formatModalResource,
  formatModalTimestamp,
  isModalJobActive,
  modalStatusLabel,
} from "@/lib/modal-jobs";
import { useModalJob, useModalJobLogs } from "@/lib/use-modal-jobs";
import { cn, formatUsd } from "@/lib/utils";

const STATUS_STYLES: Record<ModalJobStatus, string> = {
  queued: "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300",
  preparing: "border-blue-400/30 bg-blue-400/10 text-blue-600 dark:text-blue-300",
  running: "border-violet-400/30 bg-violet-400/10 text-violet-600 dark:text-violet-300",
  collecting: "border-cyan-400/30 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300",
  succeeded: "border-emerald-400/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300",
  lost: "border-destructive/30 bg-destructive/10 text-destructive",
};

const LIFECYCLE = ["queued", "preparing", "running", "collecting", "succeeded"] as const;

function StatusBadge({ status }: { status: ModalJobStatus }) {
  const active = isModalJobActive(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        STATUS_STYLES[status],
      )}
    >
      {active ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : status === "succeeded" ? (
        <CheckCircle2Icon className="size-3" />
      ) : (
        <AlertTriangleIcon className="size-3" />
      )}
      {modalStatusLabel(status)}
    </span>
  );
}

function Lifecycle({ status }: { status: ModalJobStatus }) {
  const currentIndex = LIFECYCLE.indexOf(
    status === "failed" || status === "cancelled" || status === "lost"
      ? "running"
      : status,
  );
  return (
    <ol aria-label="Job lifecycle" className="grid grid-cols-5 gap-1">
      {LIFECYCLE.map((phase, index) => {
        const reached = index <= currentIndex;
        const current =
          phase === status ||
          ((status === "failed" || status === "cancelled" || status === "lost") &&
            index === currentIndex);
        return (
          <li key={phase} className="min-w-0">
            <div
              className={cn(
                "h-1 rounded-full",
                reached
                  ? status === "failed" || status === "lost"
                    ? "bg-destructive"
                    : status === "cancelled"
                      ? "bg-amber-500"
                      : "bg-primary"
                  : "bg-muted",
              )}
            />
            <span
              className={cn(
                "mt-1 block truncate text-[9px] capitalize",
                current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {phase}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ResourceCard({
  title,
  resource,
}: {
  title: string;
  resource: ModalJobResource | null;
}) {
  const details = resource
    ? [
        resource.cpu ? `${resource.cpu} CPU` : null,
        resource.memoryMiB ? `${Math.round(resource.memoryMiB / 102.4) / 10} GB RAM` : null,
        resource.timeoutSeconds ? `${resource.timeoutSeconds}s timeout` : null,
        resource.pricePerHour !== null ? `${formatUsd(resource.pricePerHour)}/hr est.` : null,
      ].filter(Boolean)
    : [];
  return (
    <div className="min-w-0 rounded-lg border bg-muted/10 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-1 truncate text-xs font-medium" title={formatModalResource(resource)}>
        {formatModalResource(resource)}
      </p>
      {details.length > 0 ? (
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          {details.join(" · ")}
        </p>
      ) : null}
      {resource?.fallback || resource?.cache ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {resource.fallback ? (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
              fallback {resource.fallback}
            </span>
          ) : null}
          {resource.cache ? (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
              cache {resource.cache}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Transfers({
  title,
  entries,
  onOpenOutput,
}: {
  title: string;
  entries: ModalTransferEntry[];
  onOpenOutput?: (path: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} · {entries.length}
      </h3>
      <div className="overflow-hidden rounded-lg border">
        {entries.map((entry, index) => {
          const openPath = onOpenOutput ? entry.localPath : null;
          return (
            <div
              key={`${entry.path}:${index}`}
              className="flex min-w-0 items-center gap-2 border-b px-2.5 py-2 text-[11px] last:border-b-0"
            >
              <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono" title={entry.path}>
                {entry.localPath ?? entry.path}
              </span>
              {entry.status ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">{entry.status}</span>
              ) : null}
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatModalBytes(entry.bytes)}
              </span>
              {entry.error ? (
                <span className="max-w-40 truncate text-destructive" title={entry.error}>
                  {entry.error}
                </span>
              ) : null}
              {openPath ? (
                <button
                  type="button"
                  onClick={() => onOpenOutput?.(openPath)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Open ${openPath}`}
                >
                  <ExternalLinkIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LiveLogs({
  jobId,
  active,
  projectId,
}: {
  jobId: string;
  active: boolean;
  projectId?: string;
}) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const logs = useModalJobLogs(jobId, stream, { active, projectId });
  const logRef = useRef<HTMLPreElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (stickToBottomRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.content]);

  const copy = async () => {
    await navigator.clipboard.writeText(logs.content);
    toast.success(`${stream} copied`);
  };

  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center border-b bg-muted/20 px-2 py-1">
        <TerminalIcon className="mr-1.5 size-3.5 text-muted-foreground" />
        {(["stdout", "stderr"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setStream(name)}
            className={cn(
              "rounded px-2 py-1 text-[10px] font-medium",
              stream === name
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {name}
          </button>
        ))}
        {active ? (
          <span className="ml-2 flex items-center gap-1 text-[9px] text-violet-600 dark:text-violet-300">
            <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
            live
          </span>
        ) : null}
        <span className="ml-auto text-[9px] tabular-nums text-muted-foreground">
          byte {logs.cursor.toLocaleString()}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!logs.content}
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label={`Copy ${stream}`}
        >
          <CopyIcon className="size-3" />
        </button>
      </div>
      {logs.error ? (
        <p role="alert" className="border-b bg-destructive/5 px-2.5 py-1.5 text-[10px] text-destructive">
          {logs.error}
        </p>
      ) : null}
      {logs.truncated ? (
        <p className="border-b bg-amber-500/5 px-2.5 py-1 text-[9px] text-amber-700 dark:text-amber-300">
          Earlier retained output was truncated.
        </p>
      ) : null}
      <pre
        ref={logRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
        tabIndex={0}
        aria-label={`${stream} log`}
        className="h-64 overflow-auto bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-words"
      >
        {logs.content ||
          (logs.loading ? `Loading ${stream}…` : `No ${stream} output retained.`)}
      </pre>
    </section>
  );
}

export interface ModalJobDetailProps {
  jobId: string;
  projectId?: string;
  onBack?: () => void;
  onSelectJob?: (jobId: string) => void;
  onOpenOutput?: (path: string) => void;
}

export function ModalJobDetail({
  jobId,
  projectId,
  onBack,
  onSelectJob,
  onOpenOutput,
}: ModalJobDetailProps) {
  const { job, loading, mutating, error, refresh, cancel, retry, results } =
    useModalJob(jobId, { projectId });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!job || !isModalJobActive(job.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job]);

  const active = job ? isModalJobActive(job.status) : false;
  const outputs = useMemo(
    () =>
      job?.artifacts.length
        ? job.artifacts
        : (job?.outputTransfers ?? []).flatMap((entry) =>
            entry.localPath && !entry.error
              ? [{
                  path: entry.localPath,
                  bytes: entry.bytes,
                  checksum: entry.checksum,
                  status: entry.status,
                  error: entry.error,
                }]
              : [],
          ),
    [job],
  );

  const handleRetry = async () => {
    const retried = await retry();
    if (retried && retried.id !== jobId) onSelectJob?.(retried.id);
  };

  const handleResults = async () => {
    const collected = await results();
    const first = collected?.artifacts[0]?.path;
    if (first && onOpenOutput) onOpenOutput(first);
  };

  if (loading && !job) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        Loading job…
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangleIcon className="size-7 text-destructive" />
        <div>
          <p className="text-sm font-medium">Could not load this job</p>
          <p role="alert" className="mt-1 text-xs text-muted-foreground">
            {error ?? "The job record was not found."}
          </p>
        </div>
        <div className="flex gap-2">
          {onBack ? (
            <Button size="sm" variant="outline" onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const canRetry = ["failed", "cancelled", "lost"].includes(job.status);
  const canCollect = job.status === "succeeded";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Back to jobs"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
          ) : null}
          <ServerCogIcon className="size-4 shrink-0 text-violet-500" />
          <code className="min-w-0 flex-1 truncate text-xs font-semibold" title={job.id}>
            {job.id}
          </code>
          <StatusBadge status={job.status} />
          <button
            type="button"
            onClick={refresh}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Refresh job"
          >
            <RefreshCcwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
        <div className="mt-3">
          <Lifecycle status={job.status} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          {error ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          {(job.status === "failed" || job.status === "lost" || job.error) ? (
            <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <h2 className="text-xs font-semibold text-destructive">
                    {job.status === "lost" ? "Remote sandbox lost" : "Job failure"}
                  </h2>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-destructive/90">
                    {job.error ?? `The job ended with status ${job.status}.`}
                  </p>
                  {job.exitCode !== null ? (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Exit code {job.exitCode}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <section className="grid gap-2 sm:grid-cols-2">
            <ResourceCard title="Requested resource" resource={job.requestedResource} />
            <ResourceCard title="Resolved resource" resource={job.resolvedResource} />
          </section>

          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Elapsed</p>
              <p className="mt-1 flex items-center gap-1 text-xs font-medium tabular-nums">
                <Clock3Icon className="size-3 text-muted-foreground" />
                {formatModalDuration(job.startedAt, job.finishedAt, now)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Estimated spent</p>
              <p className="mt-1 text-xs font-medium tabular-nums">
                {formatUsd(job.spentEstimatedUsd)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Estimated reserved</p>
              <p className="mt-1 text-xs font-medium tabular-nums">
                {formatUsd(job.reservedEstimatedUsd)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Estimated committed</p>
              <p className="mt-1 text-xs font-medium tabular-nums">
                {formatUsd(job.committedEstimatedUsd)}
              </p>
            </div>
          </section>

          <section className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
            <p><span className="font-medium text-foreground">Created:</span> {formatModalTimestamp(job.createdAt)}</p>
            <p><span className="font-medium text-foreground">Started:</span> {formatModalTimestamp(job.startedAt)}</p>
            <p><span className="font-medium text-foreground">Finished:</span> {formatModalTimestamp(job.finishedAt)}</p>
            <p><span className="font-medium text-foreground">Source:</span> {job.agent ?? job.source ?? "—"}</p>
          </section>

          {job.command ? (
            <section>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Command
              </h3>
              <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/20 p-3 font-mono text-[11px] whitespace-pre-wrap break-words">
                {job.command}
              </pre>
            </section>
          ) : null}

          <LiveLogs jobId={job.id} active={active} projectId={projectId} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Transfers title="Inputs" entries={job.inputTransfers} />
            <Transfers
              title="Outputs"
              entries={job.outputTransfers}
              onOpenOutput={onOpenOutput}
            />
          </div>

          {outputs.length > 0 ? (
            <section className="space-y-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Artifacts · {outputs.length}
              </h3>
              <div className="flex flex-wrap gap-2">
                {outputs.map((artifact) => (
                  <button
                    key={artifact.path}
                    type="button"
                    disabled={!onOpenOutput}
                    onClick={() => onOpenOutput?.(artifact.path)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-[11px] hover:bg-muted disabled:cursor-default"
                  >
                    <FileOutputIcon className="size-3.5 shrink-0 text-emerald-500" />
                    <span className="truncate font-mono">{artifact.path}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatModalBytes(artifact.bytes)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background px-4 py-2.5">
        {active ? (
          <Button
            size="sm"
            variant="outline"
            disabled={mutating !== null}
            onClick={() => void cancel()}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            {mutating === "cancel" ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <BanIcon className="size-3.5" />
            )}
            Cancel
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            size="sm"
            variant="outline"
            disabled={mutating !== null}
            onClick={() => void handleRetry()}
            className="gap-1.5"
          >
            {mutating === "retry" ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
            )}
            Retry
          </Button>
        ) : null}
        {canCollect ? (
          <Button
            size="sm"
            variant="outline"
            disabled={mutating !== null}
            onClick={() => void handleResults()}
            className="gap-1.5"
          >
            {mutating === "results" ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <DownloadCloudIcon className="size-3.5" />
            )}
            Collect results
          </Button>
        ) : null}
        {outputs[0] && onOpenOutput ? (
          <Button
            size="sm"
            onClick={() => onOpenOutput(outputs[0].path)}
            className="ml-auto gap-1.5"
          >
            <FileOutputIcon className="size-3.5" />
            Open output
          </Button>
        ) : null}
      </footer>
    </div>
  );
}

export { StatusBadge as ModalJobStatusBadge };
