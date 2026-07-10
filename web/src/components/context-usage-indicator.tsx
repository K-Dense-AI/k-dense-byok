"use client";

import { GaugeIcon } from "lucide-react";

import { InfoTooltip } from "@/components/ui/info-tooltip";
import { cn, formatCompactTokens } from "@/lib/utils";
import type { ContextUsage } from "@/lib/use-agent";

export function ContextUsageIndicator({ usage }: { usage: ContextUsage | null }) {
  if (!usage) return null;

  const known = usage.tokens !== null && usage.percent !== null;
  const tokens = usage.tokens ?? 0;
  const percent = usage.percent ?? 0;
  const fill = Math.min(100, Math.max(0, percent));
  const critical = known && percent > 90;
  const warning = known && percent > 70;
  const value = known ? `${Math.round(percent)}%` : "?%";
  const ariaLabel = known
    ? `Model context ${percent.toFixed(1)} percent, ${tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`
    : `Model context usage recalculating, ${usage.contextWindow.toLocaleString()} token window`;

  return (
    <InfoTooltip
      content={
        <>
          <b>Model context</b>
          <br />
          {known
            ? `${formatCompactTokens(tokens)} of ${formatCompactTokens(usage.contextWindow)} tokens (${percent.toFixed(1)}%)`
            : `Recalculating after compaction · ${formatCompactTokens(usage.contextWindow)} token window`}
          <br />
          Pi estimates how much of the selected model&apos;s context window this
          conversation currently uses.
        </>
      }
    >
      <span
        role="status"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-7 cursor-help items-center gap-1.5 rounded-md px-2 font-mono text-[11px] tabular-nums text-muted-foreground",
          critical && "bg-destructive/10 text-destructive",
          warning && !critical && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden />
        <span>{value}</span>
        <span className="h-1 w-6 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span
            className={cn(
              "block h-full rounded-full transition-[width]",
              critical ? "bg-destructive" : warning ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${fill}%` }}
          />
        </span>
      </span>
    </InfoTooltip>
  );
}
