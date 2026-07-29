"use client";

/**
 * Lineage view for one sandbox artifact: what produced it, from which inputs,
 * in which run, by which model — plus the notebook entries that cite it.
 *
 * Two things this deliberately refuses to smooth over, because both are real
 * scientific hazards the rest of the app cannot see:
 *   - a `stale` artifact, whose bytes changed after the step that produced it
 *   - a citation written before the artifact's latest version, so the entry
 *     describes something other than what is on disk now
 */
import { cn } from "@/lib/utils";
import {
  getArtifactProvenance,
  type ArtifactProvenance,
  type ArtifactRef,
  type EdgeConfidence,
  type ProvenanceStep,
} from "@/lib/provenance";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BotIcon,
  CircleHelpIcon,
  FileInputIcon,
  FileOutputIcon,
  RefreshCcwIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const CONFIDENCE_COPY: Record<EdgeConfidence, { label: string; title: string }> = {
  observed: {
    label: "observed",
    title: "The tool named this file and its bytes were hashed afterward.",
  },
  inferred: {
    label: "inferred",
    title:
      "A sandbox scan attributed this change to the step, but another step finished first — the file may belong to a neighbouring step.",
  },
  declared: {
    label: "declared",
    title: "The model asserted this link and nothing verified it.",
  },
};

function ConfidenceBadge({ confidence }: { confidence: EdgeConfidence }) {
  const copy = CONFIDENCE_COPY[confidence];
  return (
    <span
      title={copy.title}
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider",
        confidence === "observed" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        confidence === "inferred" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        confidence === "declared" && "bg-muted text-muted-foreground",
      )}
    >
      {copy.label}
    </span>
  );
}

function shortHash(sha?: string): string | null {
  return sha ? sha.slice(0, 12) : null;
}

function ArtifactRow({
  ref_,
  onOpenFile,
}: {
  ref_: ArtifactRef;
  onOpenFile?: (path: string) => void;
}) {
  const hash = shortHash(ref_.sha256);
  return (
    <li className="flex items-baseline gap-1.5 py-0.5">
      <button
        type="button"
        disabled={!onOpenFile || ref_.change === "deleted"}
        onClick={() => onOpenFile?.(ref_.path)}
        className={cn(
          "truncate font-mono text-[11px]",
          onOpenFile && ref_.change !== "deleted"
            ? "text-foreground/80 underline-offset-2 hover:underline"
            : "text-foreground/60",
          ref_.change === "deleted" && "line-through",
        )}
        title={ref_.path}
      >
        {ref_.path}
      </button>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {ref_.change === "deleted" ? "deleted" : formatBytes(ref_.size)}
      </span>
      {hash && (
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground/70"
          title={`sha256:${ref_.sha256}`}
        >
          {hash}
        </span>
      )}
      {ref_.identityAt === "harvest" && (
        <span
          className="shrink-0 text-[10px] text-muted-foreground"
          title="Hashed when the subagent's record was parsed, not when the step wrote the file — the bytes may already have changed by then."
        >
          hashed later
        </span>
      )}
      {ref_.hashSkipped && (
        <span
          className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
          title={
            ref_.hashSkipped === "too-large"
              ? "Not hashed: above the size limit. Identity is size+mtime only."
              : "Not hashed: the file could not be read."
          }
        >
          unhashed
        </span>
      )}
      <ConfidenceBadge confidence={ref_.confidence} />
    </li>
  );
}

function StepCard({
  step,
  target,
  onOpenFile,
}: {
  step: ProvenanceStep;
  target: string;
  onOpenFile?: (path: string) => void;
}) {
  const outputRef = step.outputs.find((o) => o.path === target);
  const otherOutputs = step.outputs.filter((o) => o.path !== target);
  return (
    <div className="rounded-md border bg-card/40 p-2.5">
      <div className="flex items-center gap-1.5">
        <WrenchIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{step.toolName}</span>
        {step.isError && (
          <span className="rounded bg-destructive/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-destructive">
            error
          </span>
        )}
        {outputRef && <ConfidenceBadge confidence={outputRef.confidence} />}
        {/* The target's own ref is summarised by the badge above rather than
            rendered as an ArtifactRow, so its timing marker has to live here or
            the card silently implies a write-time hash it does not have. */}
        {outputRef?.identityAt === "harvest" && (
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            title="This step ran inside a subagent, so the file was hashed when its record was parsed rather than when the step wrote it."
          >
            hashed later
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {formatWhen(step.timestamp)}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground">
        {step.model && (
          <span className="flex items-center gap-1">
            <BotIcon className="size-2.5" />
            <span className="font-mono">{step.model}</span>
          </span>
        )}
        <span title={step.role === "subagent" ? step.agentName : undefined}>
          {step.role === "subagent" ? `subagent${step.agentName ? `: ${step.agentName}` : ""}` : "lead agent"}
        </span>
        {step.runId && (
          <span className="font-mono" title={`Run ${step.runId}`}>
            run {step.runId.replace(/^run_/, "").slice(0, 8)}
          </span>
        )}
        <span className="font-mono" title={`Session ${step.sessionId}`}>
          session {step.sessionId.slice(0, 8)}
        </span>
      </div>

      {step.degraded && (
        <p className="mt-1.5 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="mt-px size-2.5 shrink-0" />
          {step.degraded === "sandbox-too-large"
            ? "Sandbox exceeded the scan budget — file attribution for this step is incomplete."
            : step.degraded === "scan-failed"
              ? "The sandbox scan failed — file attribution for this step is incomplete."
              : "Ran inside a subagent and was reconstructed afterward, so this step's file effects could not be observed directly. Any files below are attributed by timing, not observation."}
        </p>
      )}

      {step.inputs.length > 0 && (
        <div className="mt-2">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <FileInputIcon className="size-2.5" /> Inputs
          </p>
          <ul className="mt-0.5">
            {step.inputs.map((input) => (
              <ArtifactRow key={input.path} ref_={input} onOpenFile={onOpenFile} />
            ))}
          </ul>
        </div>
      )}

      {otherOutputs.length > 0 && (
        <div className="mt-2">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <FileOutputIcon className="size-2.5" /> Also wrote
          </p>
          <ul className="mt-0.5">
            {otherOutputs.map((output) => (
              <ArtifactRow key={output.path} ref_={output} onOpenFile={onOpenFile} />
            ))}
          </ul>
        </div>
      )}

      {step.truncatedEdges ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          + {step.truncatedEdges} more file{step.truncatedEdges === 1 ? "" : "s"} not recorded
          (per-step limit)
        </p>
      ) : null}

      {step.args !== undefined && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
            Arguments
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-relaxed">
            {JSON.stringify(step.args, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

const STALENESS_COPY = {
  current: {
    Icon: ShieldCheckIcon,
    className: "text-emerald-600 dark:text-emerald-400",
    text: "Current — the bytes on disk match what the producing step recorded.",
  },
  stale: {
    Icon: AlertTriangleIcon,
    className: "text-amber-600 dark:text-amber-400",
    text: "Stale — this file changed after the step that produced it. Anything citing it may describe a different version.",
  },
  unknown: {
    Icon: CircleHelpIcon,
    className: "text-muted-foreground",
    text: "Unverified — no recorded hash to compare against, so sameness could not be checked.",
  },
  /**
   * Also "unknown" on the wire, but for a different reason worth stating: the
   * bytes match a hash taken when the subagent's record was parsed rather than
   * when the step wrote the file, so this only rules out changes since then.
   */
  unknownRetrospective: {
    Icon: CircleHelpIcon,
    className: "text-muted-foreground",
    text: "Unchanged since this record was reconstructed — but the producing step ran inside a subagent and its bytes were never hashed at the time, so a match cannot confirm this is what it produced.",
  },
} as const;

export interface ProvenancePanelProps {
  path: string;
  projectId: string;
  onOpenFile?: (path: string) => void;
  /**
   * Jump to a notebook entry in the Lab Notebook view. The notebook view is
   * scoped to the active tab's session, so a citation from a different session
   * opens the notebook without focusing the entry.
   */
  onOpenNotebookEntry?: (entryId: string) => void;
}

export function ProvenancePanel({
  path,
  projectId,
  onOpenFile,
  onOpenNotebookEntry,
}: ProvenancePanelProps) {
  const [data, setData] = useState<ArtifactProvenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getArtifactProvenance(path, projectId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId]);

  useEffect(() => load(), [load]);

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading provenance…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangleIcon className="size-5 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">{error}</p>
        <button
          onClick={load}
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCcwIcon className="size-3" /> Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const hasHistory = data.producedBy.length > 0;
  // Distinguish "we have no hash" from "we have one, but it was taken too late
  // to certify anything" — both arrive as `unknown`.
  const latestRef = data.producedBy[0]?.outputs.find((o) => o.path === data.path);
  const staleness =
    data.staleness === "unknown" && latestRef?.identityAt === "harvest" && latestRef.sha256
      ? STALENESS_COPY.unknownRetrospective
      : STALENESS_COPY[data.staleness];

  return (
    <div className="h-full overflow-auto px-3 py-3">
      {/* Identity */}
      <div className="rounded-md border bg-card/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            This version
          </p>
          <button
            onClick={load}
            disabled={loading}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Re-read from disk"
          >
            <RefreshCcwIcon className={cn("size-2.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>
        {data.current ? (
          <div className="mt-1 space-y-0.5">
            <p className="font-mono text-[11px] text-foreground/80">
              sha256:{data.current.sha256 ?? "—"}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {formatBytes(data.current.size)} · modified {formatWhen(data.current.mtimeMs)}
            </p>
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">
            This file no longer exists in the sandbox.
          </p>
        )}
        <p className={cn("mt-2 flex items-start gap-1 text-[10px]", staleness.className)}>
          <staleness.Icon className="mt-px size-2.5 shrink-0" />
          {staleness.text}
        </p>
      </div>

      {/* Lineage */}
      <div className="mt-3">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Produced by {hasHistory ? `(${data.producedBy.length})` : ""}
        </p>
        {hasHistory ? (
          <div className="space-y-2">
            {data.producedBy.map((step) => (
              <StepCard
                key={step.id}
                step={step}
                target={data.path}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
            No recorded provenance. Either this file predates provenance recording,
            it was uploaded rather than produced by the agent, or it was written
            during a run whose attribution degraded.
          </p>
        )}
      </div>

      {/* Notebook citations */}
      {data.citedBy.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Cited in the notebook ({data.citedBy.length})
          </p>
          <div className="space-y-1">
            {data.citedBy.map((citation) => (
              <button
                key={citation.id}
                type="button"
                disabled={!onOpenNotebookEntry}
                onClick={() => onOpenNotebookEntry?.(citation.id)}
                className={cn(
                  "flex w-full items-start gap-1.5 rounded-md border bg-card/40 px-2 py-1.5 text-left",
                  onOpenNotebookEntry && "hover:bg-muted/50",
                )}
              >
                <span className="mt-px shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {citation.type}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-foreground/90">
                    {citation.title}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {citation.role} · {formatWhen(citation.timestamp)}
                  </span>
                  {citation.precedesLatestOutput && (
                    <span className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                      <AlertTriangleIcon className="mt-px size-2.5 shrink-0" />
                      Written before the latest version of this file — the entry may
                      describe different bytes.
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Downstream reads */}
      {data.readByTotal > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Read by ({data.readByTotal})
          </p>
          <ul className="space-y-0.5">
            {data.readBy.map((step) => (
              <li
                key={step.id}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <ArrowRightIcon className="size-2.5 shrink-0" />
                <span className="font-mono">{step.toolName}</span>
                <span className="text-[10px]">{formatWhen(step.timestamp)}</span>
              </li>
            ))}
          </ul>
          {data.readByTotal > data.readBy.length && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              + {data.readByTotal - data.readBy.length} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}
