"use client";

import { CpuIcon, GpuIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useSystemResources } from "@/lib/use-system-resources";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "--";
  const gb = n / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

function toneFor(pct: number): "ok" | "warn" | "hot" {
  if (pct >= 90) return "hot";
  if (pct >= 75) return "warn";
  return "ok";
}

const TEXT_TONE = {
  ok: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  hot: "text-destructive",
} as const;

const BAR_TONE = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  hot: "bg-destructive",
} as const;

/**
 * Header pill showing live host-resource usage (CPU / RAM / GPU), with a
 * hover card breaking down system vs. app usage plus disk space. Renders
 * nothing until the first stats fetch succeeds.
 */
export function ResourceMonitor({ className }: { className?: string }) {
  const stats = useSystemResources();
  if (!stats) return null;

  const cpuPct = Math.round(stats.cpu.systemPct);
  const memPct = Math.round(
    stats.memory.totalBytes > 0
      ? (stats.memory.usedBytes / stats.memory.totalBytes) * 100
      : 0,
  );
  const gpuPct =
    stats.gpu?.utilizationPct !== null && stats.gpu?.utilizationPct !== undefined
      ? Math.round(stats.gpu.utilizationPct)
      : null;
  const diskPct =
    stats.disk && stats.disk.totalBytes > 0
      ? Math.round((stats.disk.usedBytes / stats.disk.totalBytes) * 100)
      : null;

  return (
    <HoverCard closeDelay={120} openDelay={80}>
      <HoverCardTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-auto gap-2.5 px-2.5 py-1.5 font-mono text-[11px] tabular-nums",
            className,
          )}
          aria-label={`System resources: CPU ${cpuPct}%, memory ${memPct}%${
            gpuPct !== null ? `, GPU ${gpuPct}%` : ""
          }`}
        >
          <PillSegment icon={CpuIcon} pct={cpuPct} />
          <PillSegment icon={MemoryStickIcon} pct={memPct} />
          {gpuPct !== null && <PillSegment icon={GpuIcon} pct={gpuPct} />}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-80 p-4">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          System resources
        </div>
        <div className="mt-3 space-y-3">
          <MeterRow
            icon={CpuIcon}
            label="CPU"
            pct={cpuPct}
            detail={`${stats.cpu.cores} cores · app ${stats.cpu.processPct.toFixed(1)}%`}
          />
          <MeterRow
            icon={MemoryStickIcon}
            label="Memory"
            pct={memPct}
            detail={`${formatBytes(stats.memory.usedBytes)} / ${formatBytes(
              stats.memory.totalBytes,
            )} · app ${formatBytes(stats.memory.processRssBytes)}`}
          />
          {stats.gpu && gpuPct !== null && (
            <MeterRow
              icon={GpuIcon}
              label={stats.gpu.name}
              pct={gpuPct}
              detail={
                stats.gpu.memUsedBytes !== null && stats.gpu.memTotalBytes !== null
                  ? `${formatBytes(stats.gpu.memUsedBytes)} / ${formatBytes(
                      stats.gpu.memTotalBytes,
                    )} VRAM`
                  : "utilization"
              }
            />
          )}
          {stats.disk && diskPct !== null && (
            <MeterRow
              icon={HardDriveIcon}
              label="Disk"
              pct={diskPct}
              detail={`${formatBytes(stats.disk.freeBytes)} free of ${formatBytes(
                stats.disk.totalBytes,
              )}`}
            />
          )}
        </div>
        <div className="text-muted-foreground/70 mt-3 text-[11px]">
          Machine-wide usage, sampled every few seconds. &ldquo;app&rdquo; is the
          Kady backend process.
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function PillSegment({ icon: Icon, pct }: { icon: LucideIcon; pct: number }) {
  const tone = toneFor(pct);
  return (
    <span className={cn("flex items-center gap-1", TEXT_TONE[tone])}>
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="w-[3ch] text-right font-semibold">{pct}%</span>
    </span>
  );
}

function MeterRow({
  icon: Icon,
  label,
  pct,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  pct: number;
  detail: string;
}) {
  const tone = toneFor(pct);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
        <span className={cn("font-mono text-xs tabular-nums", TEXT_TONE[tone])}>
          {pct}%
        </span>
      </div>
      <div className="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-[width]", BAR_TONE[tone])}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="text-muted-foreground mt-0.5 text-[11px]">{detail}</div>
    </div>
  );
}
