"use client";

import { useMemo, useState } from "react";
import { CheckIcon, BrainCircuitIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import models from "@/data/models.json";

export type Model = {
  id: string;
  label: string;
  provider: string;
  tier: "budget" | "mid" | "high" | "flagship";
  context_length: number;
  pricing: { prompt: number; completion: number };
  modality: string | null;
  description: string;
  default?: boolean;
};

const ALL_MODELS = models as Model[];

const DEFAULT_MODEL = ALL_MODELS.find((m) => m.default) ?? ALL_MODELS[0];

const TIER_STYLES: Record<string, { dot: string; badge: string }> = {
  budget:   { dot: "bg-slate-400",  badge: "text-slate-500 dark:text-slate-400" },
  mid:      { dot: "bg-sky-400",    badge: "text-sky-600 dark:text-sky-400" },
  high:     { dot: "bg-violet-500", badge: "text-violet-600 dark:text-violet-400" },
  flagship: { dot: "bg-amber-500",  badge: "text-amber-600 dark:text-amber-400" },
};

const PROVIDER_COLORS: Record<string, string> = {
  Google:    "text-blue-600 dark:text-blue-400",
  Anthropic: "text-orange-600 dark:text-orange-400",
  OpenAI:    "text-emerald-600 dark:text-emerald-400",
  DeepSeek:  "text-cyan-600 dark:text-cyan-400",
  xAI:       "text-rose-600 dark:text-rose-400",
  Meta:      "text-indigo-600 dark:text-indigo-400",
  Venice:    "text-purple-600 dark:text-purple-400",
};

function TierDot({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-block size-1.5 rounded-full shrink-0", TIER_STYLES[tier]?.dot ?? "bg-muted")} />
  );
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

export { DEFAULT_MODEL };

export function ModelSelector({
  selected,
  onChange,
}: {
  selected: Model;
  onChange: (model: Model) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return ALL_MODELS;
    const q = search.toLowerCase();
    return ALL_MODELS.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  }, [search]);

  const handleSelect = (model: Model) => {
    onChange(model);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(""); }}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs select-none",
            open
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40"
          )}
          role="button"
          tabIndex={0}
        >
          <BrainCircuitIcon className="size-3 shrink-0 text-muted-foreground" />
          <TierDot tier={selected.tier} />
          <span className="min-w-0 truncate font-medium text-foreground">{selected.label}</span>
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
        className="w-96 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
            autoFocus
          />
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {filtered.length}
          </span>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.map((model) => {
            const isSelected = selected.id === model.id;
            const providerColor = PROVIDER_COLORS[model.provider] ?? "text-muted-foreground";
            return (
              <div
                key={model.id}
                onClick={() => handleSelect(model)}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-muted/60",
                  isSelected && "bg-muted/40"
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background"
                  )}
                >
                  {isSelected && <CheckIcon className="size-2" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <TierDot tier={model.tier} />
                    <span className="font-semibold text-foreground">{model.label}</span>
                    {model.default && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                        recommended
                      </span>
                    )}
                    <span className={cn("text-[10px] font-medium", providerColor)}>
                      {model.provider}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                    <span>{formatContext(model.context_length)}</span>
                    <span>·</span>
                    <span>${model.pricing.prompt.toFixed(2)} in / ${model.pricing.completion.toFixed(2)} out per 1M tok</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t px-3 py-1.5 flex-wrap">
          {Object.entries(TIER_STYLES).map(([tier, s]) => (
            <span key={tier} className="flex items-center gap-1 text-[10px] text-muted-foreground capitalize">
              <span className={cn("inline-block size-1.5 rounded-full", s.dot)} />
              {tier}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
