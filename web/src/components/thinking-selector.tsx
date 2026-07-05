"use client";

import { useState } from "react";
import { BrainIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Pi's reasoning levels (`ThinkingLevel` in @earendil-works/pi-agent-core). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

export const THINKING_LEVELS: { id: ThinkingLevel; label: string; description: string }[] = [
  { id: "off", label: "Off", description: "No extended reasoning — fastest and cheapest." },
  { id: "minimal", label: "Minimal", description: "Bare-minimum reasoning for models that require some." },
  { id: "low", label: "Low", description: "Brief reasoning for straightforward tasks." },
  { id: "medium", label: "Medium", description: "Balanced reasoning effort and cost." },
  { id: "high", label: "High", description: "Deep reasoning for hard problems." },
  { id: "xhigh", label: "XHigh", description: "Maximum effort — slowest, most thorough, most tokens." },
];

export function ThinkingSelector({
  selected,
  onChange,
  disabled = false,
  disabledReason = "This model doesn't support adjustable thinking",
}: {
  selected: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = THINKING_LEVELS.find((l) => l.id === selected) ?? THINKING_LEVELS[0];

  const chip = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors text-xs select-none",
        disabled
          ? "cursor-not-allowed border-transparent opacity-50"
          : open || selected !== "off"
            ? "cursor-pointer border-border bg-muted/60"
            : "cursor-pointer border-transparent hover:border-border hover:bg-muted/40",
      )}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
    >
      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "whitespace-nowrap",
          disabled ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {disabled ? "Off" : current.label}
      </span>
      {!disabled && (
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform ml-0.5",
            open && "rotate-180",
          )}
        />
      )}
    </div>
  );

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            {disabledReason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Thinking
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {THINKING_LEVELS.map((level) => {
            const isSelected = level.id === selected;
            return (
              <div
                key={level.id}
                onClick={() => {
                  onChange(level.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2.5 text-xs transition-colors cursor-pointer hover:bg-muted/60",
                  isSelected && "bg-muted/40",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background",
                  )}
                >
                  {isSelected && <CheckIcon className="size-2" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-foreground">{level.label}</span>
                  <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">
                    {level.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// The selected level rides the run request as `thinkingLevel`; the backend
// applies it with Pi's setThinkingLevel (clamped to what the model supports).
// Disabled for Ollama (reasoning:false) and Fusion (wire body rewritten) models,
// whose runs carry no level.
