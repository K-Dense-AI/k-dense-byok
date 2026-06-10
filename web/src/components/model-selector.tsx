"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  SearchIcon,
  HardDriveIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import models from "@/data/models.json";
import { useModels } from "@/lib/use-models";

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
  expertDefault?: boolean;
};

const STATIC_MODELS = models as Model[];

const DEFAULT_MODEL = STATIC_MODELS.find((m) => m.default) ?? STATIC_MODELS[0];

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
  Ollama:    "text-teal-600 dark:text-teal-400",
};

const isOllama = (m: Model) => m.provider === "Ollama" || m.id.startsWith("ollama/");

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

// ---------------------------------------------------------------------------
// Reusable interior: search input + remote/local model list.
// ---------------------------------------------------------------------------

interface ModelPickerListProps {
  selected: Model;
  onSelect: (model: Model) => void;
  compact?: boolean;
}

function ModelPickerList({ selected, onSelect, compact }: ModelPickerListProps) {
  const [search, setSearch] = useState("");
  const { models: allModels, ollamaAvailable, ollamaModels, refresh } = useModels();

  // PopoverContent unmounts when closed, so this effectively re-probes
  // Ollama each time the user opens the picker — lets them start the
  // daemon and see models appear without a full reload.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const { remoteFiltered, localFiltered, totalCount } = useMemo(() => {
    const q = search.toLowerCase();
    const matches = (m: Model) =>
      !q ||
      m.label.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q);

    const remote: Model[] = [];
    const local: Model[] = [];
    for (const m of allModels) {
      if (!matches(m)) continue;
      (isOllama(m) ? local : remote).push(m);
    }
    return { remoteFiltered: remote, localFiltered: local, totalCount: remote.length + local.length };
  }, [allModels, search]);

  const isRecommended = (m: Model): boolean => Boolean(m.default);

  const renderModelRow = (model: Model) => {
    const isSelected = selected.id === model.id;
    const providerColor = PROVIDER_COLORS[model.provider] ?? "text-muted-foreground";
    const local = isOllama(model);
    return (
      <div
        key={model.id}
        role="option"
        aria-selected={isSelected}
        aria-label={`${model.label} by ${model.provider}`}
        tabIndex={0}
        onClick={() => onSelect(model)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(model);
          }
        }}
        className={cn(
          "flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none",
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
            <span className="font-semibold text-foreground truncate">{model.label}</span>
            {isRecommended(model) && (
              <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary shrink-0">
                recommended
              </span>
            )}
            <span className={cn("text-[10px] font-medium shrink-0", providerColor)}>
              {model.provider}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
            {model.context_length > 0 && (
              <>
                <span>{formatContext(model.context_length)}</span>
                <span>·</span>
              </>
            )}
            {local ? (
              <span>Runs locally · no API cost</span>
            ) : (
              <span>${model.pricing.prompt.toFixed(2)} in / ${model.pricing.completion.toFixed(2)} out per 1M tok</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 border-b px-3 py-2 shrink-0">
        <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models..."
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          autoFocus
        />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {totalCount}
        </span>
      </div>

      <div
        role="listbox"
        aria-label="Models"
        className={cn("overflow-y-auto py-1", compact ? "max-h-72" : "max-h-80")}
      >
        {remoteFiltered.map(renderModelRow)}

        {(localFiltered.length > 0 || !search) && (
          <>
            {remoteFiltered.length > 0 && (
              <div className="my-1 border-t border-border/60" />
            )}
            <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <HardDriveIcon className="size-3" />
              <span>Local (Ollama)</span>
              <span className="ml-auto font-normal normal-case tracking-normal text-[10px] text-muted-foreground/70">
                {ollamaAvailable ? `${ollamaModels.length} available` : "not running"}
              </span>
            </div>
            {localFiltered.map(renderModelRow)}
            {!search && ollamaAvailable && ollamaModels.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground/80">
                Ollama is running but no models are pulled yet. Run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">ollama pull qwen3.6</code>{" "}
                to add one.
              </div>
            )}
            {!search && !ollamaAvailable && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground/80 leading-relaxed">
                Start Ollama to use local models. Run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">ollama serve</code>{" "}
                and{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">ollama pull qwen3.6</code>
                , then reopen this menu.
              </div>
            )}
          </>
        )}

        {totalCount === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            No models match &ldquo;{search}&rdquo;.
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t px-3 py-1.5 flex-wrap shrink-0">
        {Object.entries(TIER_STYLES).map(([tier, s]) => (
          <span key={tier} className="flex items-center gap-1 text-[10px] text-muted-foreground capitalize">
            <span className={cn("inline-block size-1.5 rounded-full", s.dot)} />
            {tier}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-model selector (legacy-compatible). Kept as-is for any callers
// that only need one model dropdown (e.g. workflow panels).
// ---------------------------------------------------------------------------

export function ModelSelector({
  selected,
  onChange,
}: {
  selected: Model;
  onChange: (model: Model) => void;
}) {
  const [open, setOpen] = useState(false);

  const handleSelect = (model: Model) => {
    onChange(model);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <ModelPickerList selected={selected} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}
