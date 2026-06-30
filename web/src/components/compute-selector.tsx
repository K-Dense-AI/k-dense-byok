"use client";

import { useState } from "react";
import { CheckIcon, ZapIcon, ChevronDownIcon, ExternalLinkIcon, MonitorIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import instances from "@/data/modal-instances.json";

export type ModalInstance = {
  id: string;
  label: string;
  modalGpu: string | null;
  vram: number | null;
  pricePerHour: number;
  architecture: string | null;
  tier: "cpu" | "budget" | "mid" | "high" | "flagship" | "local";
  bestFor: string;
  description: string;
};

export const LOCAL_INSTANCE: ModalInstance = {
  id: "local",
  label: "Local",
  modalGpu: null,
  vram: null,
  pricePerHour: 0,
  architecture: null,
  tier: "local",
  bestFor: "Default sandbox environment",
  description: "Run code in the built-in sandbox — no Modal compute needed.",
};

const ALL_INSTANCES = instances as ModalInstance[];

const TIER_STYLES: Record<string, { dot: string; badge: string }> = {
  local:    { dot: "bg-emerald-400", badge: "text-emerald-600 dark:text-emerald-400" },
  cpu:      { dot: "bg-slate-400",   badge: "text-slate-500" },
  budget:   { dot: "bg-sky-400",     badge: "text-sky-600 dark:text-sky-400" },
  mid:      { dot: "bg-violet-500",  badge: "text-violet-600 dark:text-violet-400" },
  high:     { dot: "bg-amber-500",   badge: "text-amber-600 dark:text-amber-400" },
  flagship: { dot: "bg-rose-500",    badge: "text-rose-600 dark:text-rose-400" },
};

function TierDot({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-block size-1.5 rounded-full shrink-0", TIER_STYLES[tier]?.dot ?? "bg-muted")} />
  );
}

/**
 * Picker UI for compute selection — no trigger / no popover wrapper.
 */
export function ComputePickerBody({
  selected,
  onChange,
  modalConfigured = true,
  onSelected,
}: {
  selected: ModalInstance | null;
  onChange: (instance: ModalInstance | null) => void;
  modalConfigured?: boolean;
  onSelected?: () => void;
}) {
  const effective = selected ?? LOCAL_INSTANCE;

  const handleSelect = (instance: ModalInstance) => {
    if (instance.id !== "local" && !modalConfigured) return;
    onChange(instance.id === "local" ? null : instance);
    onSelected?.();
  };

  return (
    <>
      {!modalConfigured && (
        <div className="flex items-start gap-2.5 border-b bg-amber-500/5 px-3 py-2.5">
          <div className="mt-0.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
          <div className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Modal API keys not configured.</span>{" "}
            Set <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">MODAL_TOKEN_ID</code> and{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">MODAL_TOKEN_SECRET</code> in your{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">.env</code> file.
            <a
              href="https://modal.com"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
            >
              Create an account at modal.com
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </div>
        </div>
      )}

      <TooltipProvider>
        <div className="max-h-80 overflow-y-auto py-1">
          {[LOCAL_INSTANCE, "divider" as const, ...ALL_INSTANCES].map((item) => {
            if (item === "divider") {
              return (
                <div key="divider" className="my-1 border-t px-3 pt-1.5 pb-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Modal Compute
                  </span>
                </div>
              );
            }
            const instance = item;
            const isSelected = effective.id === instance.id;
            const styles = TIER_STYLES[instance.tier];

            const isLocal = instance.id === "local";
            const enabled = isLocal || modalConfigured;

            const row = (
              <div
                key={instance.id}
                onClick={() => handleSelect(instance)}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2.5 text-xs transition-colors",
                  enabled
                    ? "cursor-pointer hover:bg-muted/60"
                    : "cursor-not-allowed opacity-50",
                  isSelected && enabled && "bg-muted/40"
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected && enabled
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background"
                  )}
                >
                  {isSelected && enabled && <CheckIcon className="size-2" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <TierDot tier={instance.tier} />
                    <span className={cn("font-semibold", enabled ? "text-foreground" : "text-muted-foreground")}>{instance.label}</span>
                    {isLocal ? (
                      <span className="text-muted-foreground">Sandbox</span>
                    ) : instance.vram ? (
                      <span className="text-muted-foreground">{instance.vram}GB VRAM</span>
                    ) : (
                      <span className="text-muted-foreground">No GPU</span>
                    )}
                    {!isLocal && (
                      <span className={cn("ml-auto text-[10px] font-medium tabular-nums", enabled ? styles.badge : "text-muted-foreground")}>
                        ${instance.pricePerHour}/hr
                      </span>
                    )}
                    {isLocal && (
                      <span className={cn("ml-auto text-[10px] font-medium", styles.badge)}>Free</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">{instance.description}</p>
                </div>
              </div>
            );

            if (!enabled) {
              return (
                <Tooltip key={instance.id}>
                  <TooltipTrigger asChild>{row}</TooltipTrigger>
                  <TooltipContent side="right" className="max-w-56">
                    Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in .env to enable compute
                  </TooltipContent>
                </Tooltip>
              );
            }

            return row;
          })}
        </div>
      </TooltipProvider>

      <div className="flex items-center gap-3 border-t px-3 py-1.5 flex-wrap">
        {Object.entries(TIER_STYLES)
          .filter(([tier]) => tier !== "local")
          .map(([tier, s]) => (
            <span key={tier} className="flex items-center gap-1 text-[10px] text-muted-foreground capitalize">
              <span className={cn("inline-block size-1.5 rounded-full", s.dot)} />
              {tier}
            </span>
          ))}
      </div>
    </>
  );
}

export function ComputeSelector({
  selected,
  onChange,
  modalConfigured = true,
}: {
  selected: ModalInstance | null;
  onChange: (instance: ModalInstance | null) => void;
  modalConfigured?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const effective = selected ?? LOCAL_INSTANCE;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs select-none",
            open || selected
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40"
          )}
          role="button"
          tabIndex={0}
        >
          {effective.id === "local" ? (
            <>
              <MonitorIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="whitespace-nowrap text-muted-foreground">Local</span>
            </>
          ) : (
            <>
              <ZapIcon className="size-3 shrink-0 text-muted-foreground" />
              <TierDot tier={effective.tier} />
              <span className="min-w-0 truncate font-medium text-foreground">{effective.label}</span>
              {effective.vram && (
                <span className="shrink-0 text-muted-foreground">{effective.vram}GB</span>
              )}
              <span className={cn("shrink-0 text-[10px]", TIER_STYLES[effective.tier]?.badge)}>
                ${effective.pricePerHour}/hr
              </span>
            </>
          )}
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform ml-0.5",
              open && "rotate-180"
            )}
          />
        </div>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Compute
          </span>
        </div>
        <ComputePickerBody
          selected={selected}
          onChange={onChange}
          modalConfigured={modalConfigured}
          onSelected={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

// The selected instance is threaded to the backend as `computeTarget` on the
// run request and read by the `modal_run` tool as its default — no prompt
// injection / skill activation needed (that was the previous architecture).
