"use client";

import { AlertTriangleIcon, LockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn, formatCompactTokens, formatUsd } from "@/lib/utils";
import type { ProjectCostSummary } from "@/lib/use-project-cost";
import type { CostEntry, SessionCostSummary } from "@/lib/use-session-cost";

interface SessionCostPillProps {
  summary: SessionCostSummary;
  projectSummary?: ProjectCostSummary;
  limitUsd?: number | null;
  loading?: boolean;
  className?: string;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return formatCompactTokens(n);
}

function shortModel(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

export function SessionCostPill({
  summary,
  projectSummary,
  limitUsd: limitUsdProp,
  loading = false,
  className,
}: SessionCostPillProps) {
  // The cap is enforced against *committed* money — ledgered spend plus
  // compute reservations plus runs still in flight. Showing only ledgered
  // spend meant the pill could read "$4.10 / $5.00" while the server refused
  // new work, with nothing on screen to explain why.
  const spentUsd = projectSummary?.spentUsd ?? projectSummary?.totalUsd ?? 0;
  const projectTotal =
    projectSummary?.budget?.committedUsd ??
    projectSummary?.budget?.totalUsd ??
    spentUsd;
  const heldUsd = Math.max(0, projectTotal - spentUsd);
  const reservedUsd = projectSummary?.budget?.reservedUsd ?? 0;
  const inFlightUsd = projectSummary?.budget?.inFlightUsd ?? 0;
  const sessionTotal = summary.totalUsd ?? 0;
  const limitUsd =
    limitUsdProp !== undefined
      ? limitUsdProp
      : projectSummary?.limitUsd ?? null;

  const budgetState = projectSummary?.budget?.state ?? "ok";
  const ratio =
    limitUsd !== null && limitUsd > 0
      ? Math.min(1, projectTotal / limitUsd)
      : null;

  const hasData =
    summary.entries.length > 0 ||
    sessionTotal > 0 ||
    projectTotal > 0 ||
    (summary.subscriptionTokens ?? 0) > 0 ||
    (projectSummary?.subscriptionTokens ?? 0) > 0 ||
    (projectSummary?.sessionCount ?? 0) > 0;

  if (!hasData) {
    return null;
  }

  const warnTone = budgetState === "warn";
  const blockedTone = budgetState === "exceeded";

  return (
    <HoverCard closeDelay={120} openDelay={80}>
      <HoverCardTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-auto gap-2 px-2.5 py-1 font-mono text-[11px] tabular-nums",
            loading && "opacity-70",
            warnTone &&
              "border-amber-500/60 text-amber-600 dark:text-amber-400",
            blockedTone &&
              "border-destructive/60 text-destructive",
            className,
          )}
          aria-label={
            [
              limitUsd !== null
                ? `Project billable cost ${formatUsd(projectTotal)} of ${formatUsd(limitUsd)}`
                : `Project billable cost ${formatUsd(projectTotal)}`,
              heldUsd > 0 ? `including ${formatUsd(heldUsd)} held for work in progress` : "",
              `session billable cost ${formatUsd(sessionTotal)}`,
              (summary.subscriptionTokens ?? 0) > 0
                ? `${formatTokens(summary.subscriptionTokens ?? 0)} subscription tokens`
                : "",
            ]
              .filter(Boolean)
              .join(", ")
          }
        >
          <div className="flex items-center gap-2">
            {blockedTone && <LockIcon className="size-3 shrink-0" aria-hidden />}
            {warnTone && !blockedTone && (
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            )}
            <div className="flex flex-col items-end leading-tight">
              <span className="flex items-baseline gap-1">
                <span className="text-muted-foreground">proj</span>
                <span className="font-semibold">{formatUsd(projectTotal)}</span>
                {limitUsd !== null && (
                  <span className="text-muted-foreground">
                    / {formatUsd(limitUsd)}
                  </span>
                )}
              </span>
              <span className="flex items-baseline gap-1">
                <span className="text-muted-foreground">sess</span>
                <span className="font-semibold">{formatUsd(sessionTotal)}</span>
              </span>
              {(summary.subscriptionTokens ?? 0) > 0 ? (
                <span className="flex items-baseline gap-1">
                  <span className="text-muted-foreground">sub</span>
                  <span className="font-semibold">
                    {formatTokens(summary.subscriptionTokens ?? 0)} tok
                  </span>
                </span>
              ) : null}
            </div>
          </div>
          {ratio !== null && (
            <span
              aria-hidden
              className={cn(
                "h-1 w-10 overflow-hidden rounded-full bg-muted",
                "ml-0.5",
              )}
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width]",
                  blockedTone
                    ? "bg-destructive"
                    : warnTone
                      ? "bg-amber-500"
                      : "bg-primary",
                )}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </span>
          )}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-96 p-0">
        {projectSummary && (
          <div className="border-b p-4">
            <div className="text-muted-foreground text-xs uppercase tracking-wide">
              Project billable spend
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <div className="font-mono text-2xl font-semibold tabular-nums">
                {formatUsd(projectTotal)}
              </div>
              {limitUsd !== null && (
                <div className="text-muted-foreground font-mono text-sm tabular-nums">
                  / {formatUsd(limitUsd)}
                </div>
              )}
            </div>
            <div className="text-muted-foreground mt-0.5 text-xs">
              {formatTokens(projectSummary.totalTokens)} tokens across{" "}
              {projectSummary.sessionCount} session
              {projectSummary.sessionCount === 1 ? "" : "s"}
            </div>
            {heldUsd > 0 && (
              <div className="text-muted-foreground mt-1 text-xs">
                {formatUsd(spentUsd)} recorded
                {reservedUsd > 0 ? ` · ${formatUsd(reservedUsd)} held for compute jobs` : ""}
                {inFlightUsd > 0 ? ` · ${formatUsd(inFlightUsd)} in the current run` : ""}
              </div>
            )}
            {(projectSummary.subscriptionTokens ?? 0) > 0 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {formatTokens(projectSummary.subscriptionTokens ?? 0)} subscription
                tokens are tracked separately from this spend.
              </div>
            ) : null}
            {ratio !== null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    blockedTone
                      ? "bg-destructive"
                      : warnTone
                        ? "bg-amber-500"
                        : "bg-primary",
                  )}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            )}
            {blockedTone && (
              <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                Spend limit reached. New billable API and compute work is
                blocked until the limit is raised; provider-managed
                subscription and local runs can continue.
              </div>
            )}
            {warnTone && (
              <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                Approaching the spend limit (≥80%).
              </div>
            )}
          </div>
        )}

        <div className="border-b p-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            This session
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatUsd(sessionTotal)}
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            {formatTokens(summary.totalTokens)} tokens across{" "}
            {summary.entries.length} call
            {summary.entries.length === 1 ? "" : "s"}
          </div>
          <div className="mt-2">
            <CostRow label="Agent" costUsd={summary.agentUsd} />
            {summary.subagentUsd > 0 && (
              <CostRow label="Subagents" costUsd={summary.subagentUsd} />
            )}
            {summary.computeUsd > 0 && (
              <CostRow label="Compute (Modal)" costUsd={summary.computeUsd} />
            )}
            {(summary.subscriptionTokens ?? 0) > 0 ? (
              <div className="flex items-baseline justify-between py-1 text-sm">
                <span className="text-muted-foreground">Subscription usage</span>
                <span className="font-mono tabular-nums">
                  {formatTokens(summary.subscriptionTokens ?? 0)} tokens
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="max-h-60 overflow-y-auto p-2">
          {summary.entries.length === 0 ? (
            <div className="text-muted-foreground px-2 py-1 text-xs">
              No call-level breakdown yet.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {summary.entries.map((entry, idx) => (
                <EntryRow key={entry.entryId ?? idx} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function CostRow({ label, costUsd }: { label: string; costUsd: number }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatUsd(costUsd)}</span>
    </div>
  );
}

function EntryRow({ entry }: { entry: CostEntry }) {
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 px-2 py-1 text-[11px]">
      <span
        className="flex min-w-0 items-center gap-1 truncate"
        title={`${entry.role} · ${entry.model}`}
      >
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            entry.role === "agent"
              ? "bg-sky-500"
              : entry.role === "compute"
                ? "bg-violet-500"
                : "bg-amber-500",
          )}
          aria-hidden
        />
        <span className="truncate">{shortModel(entry.model)}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">
        {formatTokens(entry.totalTokens)} ·{" "}
        {entry.billingMode === "subscription"
          ? "subscription"
          : entry.billingMode === "external"
            ? "external"
            : entry.billingMode === "local"
              ? "local"
              : formatUsd(entry.costUsd)}
      </span>
    </li>
  );
}
