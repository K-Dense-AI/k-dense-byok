"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  isFusion?: boolean;
  fusionConfig?: Record<string, unknown>;
  sourceId?: string;
  sourceLabel?: string;
  billingMode?: "payg" | "metered_oauth" | "subscription" | "local";
  reasoning?: boolean;
  available?: boolean;
};

export function modelUsesBillableBudget(model: {
  id: string;
  billingMode?: Model["billingMode"];
}): boolean {
  if (model.billingMode === "subscription" || model.billingMode === "local") {
    return false;
  }
  return !(
    model.id.startsWith("openai-codex/") ||
    model.id.startsWith("github-copilot/") ||
    model.id.startsWith("xai/") ||
    model.id.startsWith("nvidia/") ||
    model.id.startsWith("ollama/") ||
    model.id.startsWith("openai-compatible/")
  );
}

const STATIC_MODELS = models as Model[];

const DEFAULT_MODEL = STATIC_MODELS.find((m) => m.default) ?? STATIC_MODELS[0];

const TIER_STYLES: Record<string, { dot: string; badge: string }> = {
  budget:   { dot: "bg-slate-400",  badge: "text-slate-500 dark:text-slate-400" },
  mid:      { dot: "bg-sky-400",    badge: "text-sky-600 dark:text-sky-400" },
  high:     { dot: "bg-violet-500", badge: "text-violet-600 dark:text-violet-400" },
  flagship: { dot: "bg-amber-500",  badge: "text-amber-600 dark:text-amber-400" },
};

const FUSION_DOT = "bg-red-500";
const FUSION_BADGE = "text-red-600 dark:text-red-400";

const PROVIDER_COLORS: Record<string, string> = {
  Google:    "text-blue-600 dark:text-blue-400",
  Anthropic: "text-orange-600 dark:text-orange-400",
  OpenAI:    "text-emerald-600 dark:text-emerald-400",
  "OpenAI Codex": "text-emerald-600 dark:text-emerald-400",
  "GitHub Copilot": "text-violet-600 dark:text-violet-400",
  DeepSeek:  "text-cyan-600 dark:text-cyan-400",
  xAI:       "text-rose-600 dark:text-rose-400",
  Meta:      "text-indigo-600 dark:text-indigo-400",
  NVIDIA:    "text-green-600 dark:text-green-400",
  Ollama:    "text-teal-600 dark:text-teal-400",
  "OpenAI-Compatible": "text-teal-600 dark:text-teal-400",
  "Openrouter Fusion": "text-red-600 dark:text-red-400",
};

const isOllama = (m: Model) => m.provider === "Ollama" || m.id.startsWith("ollama/");
const isOpenAICompatible = (m: Model) =>
  m.provider === "OpenAI-Compatible" || m.id.startsWith("openai-compatible/");
/** Runs on the user's own hardware — priced at $0 and grouped under "Local". */
const isLocal = (m: Model) => isOllama(m) || isOpenAICompatible(m);
const LOCAL_GROUP_IDS = new Set(["ollama", "openai-compatible"]);

function TierDot({ tier, isFusion }: { tier: string; isFusion?: boolean }) {
  if (isFusion) {
    return <span className={cn("inline-block size-1.5 rounded-full shrink-0", FUSION_DOT)} />;
  }
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
// Reusable interior: search input + models grouped by access source.
// ---------------------------------------------------------------------------

interface ModelPickerListProps {
  selected: Model;
  onSelect: (model: Model) => void;
  compact?: boolean;
}

function ModelPickerList({ selected, onSelect, compact }: ModelPickerListProps) {
  const [search, setSearch] = useState("");
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // With 200+ models the current pick is usually far below the fold; open the
  // list with it in view instead of at the Fusion presets every time.
  useEffect(() => {
    const row = selectedRowRef.current;
    const list = listRef.current;
    if (!row || !list) return;
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    list.scrollTop = Math.max(0, top);
    // Mount-only: later re-renders (search, refresh) must not yank the scroll.
  }, []);
  const {
    models: allModels,
    ollamaAvailable,
    ollamaModels,
    openaiCompatibleAvailable,
    openaiCompatibleModels,
    openaiCompatibleConfigured,
    refresh,
  } = useModels();

  // PopoverContent unmounts when closed, so this effectively re-probes both
  // local servers each time the user opens the picker — lets them start the
  // daemon and see models appear without a full reload.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const { groups, totalCount } = useMemo(() => {
    const q = search.toLowerCase();
    const matches = (m: Model) =>
      !q ||
      m.label.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q);

    const grouped = new Map<string, { label: string; models: Model[] }>();
    for (const m of allModels) {
      if (!matches(m)) continue;
      const sourceId = m.isFusion
        ? "fusion"
        : m.sourceId ??
          (isOllama(m)
            ? "ollama"
            : isOpenAICompatible(m)
              ? "openai-compatible"
              : "openrouter");
      const label = m.isFusion
        ? "OpenRouter Fusion"
        : m.sourceLabel ??
          (isOllama(m)
            ? "Local (Ollama)"
            : isOpenAICompatible(m)
              ? "Local (OpenAI-compatible)"
              : "OpenRouter");
      const group = grouped.get(sourceId) ?? { label, models: [] };
      group.models.push(m);
      grouped.set(sourceId, group);
    }
    const order = [
      "fusion",
      "openai-codex",
      "anthropic",
      "github-copilot",
      "xai",
      "openrouter",
      "nvidia",
      "ollama",
      "openai-compatible",
    ];
    const groups = [...grouped.entries()]
      .sort(([left], [right]) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        return (leftIndex < 0 ? order.length : leftIndex) -
          (rightIndex < 0 ? order.length : rightIndex);
      })
      .map(([id, group]) => ({ id, ...group }));
    return {
      groups,
      totalCount: groups.reduce((sum, group) => sum + group.models.length, 0),
    };
  }, [allModels, search]);

  const isRecommended = (m: Model): boolean => Boolean(m.default);

  const renderModelRow = (model: Model) => {
    const isSelected = selected.id === model.id;
    const available = model.available !== false;
    const providerColor = PROVIDER_COLORS[model.provider] ?? "text-muted-foreground";
    const local = isLocal(model);
    return (
      <div
        key={model.id}
        ref={isSelected ? selectedRowRef : undefined}
        role="option"
        aria-selected={isSelected}
        aria-disabled={!available}
        aria-label={`${model.label} by ${model.provider}`}
        tabIndex={available ? 0 : -1}
        onClick={() => {
          if (available) onSelect(model);
        }}
        onKeyDown={(e) => {
          if (available && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onSelect(model);
          }
        }}
        className={cn(
          "flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none",
          isSelected && "bg-muted/40",
          !available && "cursor-not-allowed opacity-50",
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
            <TierDot tier={model.tier} isFusion={model.isFusion} />
            <span className="font-semibold text-foreground truncate">{model.label}</span>
            {isRecommended(model) && (
              <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary shrink-0">
                recommended
              </span>
            )}
            <span className={cn("text-[10px] font-medium shrink-0", providerColor)}>
              {model.provider}
            </span>
            {!available ? (
              <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-medium text-destructive">
                disconnected
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
            {model.context_length > 0 && (
              <>
                <span>{formatContext(model.context_length)}</span>
                <span>·</span>
              </>
            )}
            {model.sourceId === "nvidia" ? (
              <span>Billed via NVIDIA API credits · not metered by Kady</span>
            ) : model.billingMode === "subscription" ? (
              <span>Uses provider-managed subscription limits</span>
            ) : model.billingMode === "metered_oauth" ? (
              <span>
                ${model.pricing.prompt.toFixed(2)} in / ${model.pricing.completion.toFixed(2)} out per 1M tok · extra usage
              </span>
            ) : local ? (
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
        ref={listRef}
        role="listbox"
        aria-label="Models"
        className={cn("relative overflow-y-auto py-1", compact ? "max-h-72" : "max-h-80")}
      >
        {groups.map((group, index) => (
          <div key={group.id}>
            {index > 0 ? <div className="my-1 border-t border-border/60" /> : null}
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {LOCAL_GROUP_IDS.has(group.id) ? (
                <HardDriveIcon className="size-3" aria-hidden />
              ) : (
                <BrainCircuitIcon className="size-3" aria-hidden />
              )}
              <span>{group.label}</span>
              <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                {group.id === "ollama"
                  ? ollamaAvailable
                    ? `${ollamaModels.length} available`
                    : "not running"
                  : group.id === "openai-compatible"
                    ? openaiCompatibleAvailable
                      ? `${openaiCompatibleModels.length} available`
                      : "not running"
                    : `${group.models.length} model${group.models.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {group.models.map(renderModelRow)}
          </div>
        ))}

        {!search && !groups.some((group) => group.id === "ollama") ? (
          <div>
            {groups.length > 0 ? <div className="my-1 border-t border-border/60" /> : null}
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <HardDriveIcon className="size-3" aria-hidden />
              <span>Local (Ollama)</span>
              <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                {ollamaAvailable ? "0 available" : "not running"}
              </span>
            </div>
            <div className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground/80">
              {ollamaAvailable ? (
                <>
                  Ollama is running but no models are pulled. Run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                    ollama pull qwen3.6
                  </code>
                  .
                </>
              ) : (
                <>
                  Start Ollama to use local models, then pull a model and reopen
                  this menu.
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* Unlike Ollama's section, this one stays hidden until the user opts
            in with OPENAI_COMPATIBLE_BASE_URL or a server actually answers —
            most users have never run one and don't need a dead row. */}
        {!search &&
        (openaiCompatibleConfigured || openaiCompatibleAvailable) &&
        !groups.some((group) => group.id === "openai-compatible") ? (
          <div>
            {groups.length > 0 ? <div className="my-1 border-t border-border/60" /> : null}
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <HardDriveIcon className="size-3" aria-hidden />
              <span>Local (OpenAI-compatible)</span>
              <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                {openaiCompatibleAvailable ? "0 available" : "not running"}
              </span>
            </div>
            <div className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground/80">
              {openaiCompatibleAvailable ? (
                <>
                  The server is up but serving no models. Load one and reopen
                  this menu.
                </>
              ) : (
                <>
                  No server answered at{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                    OPENAI_COMPATIBLE_BASE_URL
                  </code>
                  . Start LM Studio, vLLM, or another OpenAI-compatible server
                  and reopen this menu.
                </>
              )}
            </div>
          </div>
        ) : null}

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
        {allModels.some(m => m.isFusion) && (
          <span className="flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400 font-medium">
            <span className={cn("inline-block size-1.5 rounded-full", FUSION_DOT)} />
            Openrouter Fusion
          </span>
        )}
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
  const { modelAvailability } = useModels();
  const selectedAvailability = modelAvailability(selected);
  const selectedAvailable = selectedAvailability === "available";

  const handleSelect = (model: Model) => {
    onChange(model);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-28 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs select-none",
            open
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40"
          )}
          role="button"
          tabIndex={0}
          aria-label={
            selectedAvailability === "checking"
              ? `Select model, checking ${selected.label} provider`
              : selectedAvailable
              ? `Select model, current ${selected.label}`
              : `Select model, current ${selected.label} is disconnected`
          }
        >
          <BrainCircuitIcon className="size-3 shrink-0 text-muted-foreground" />
          <TierDot tier={selected.tier} isFusion={selected.isFusion} />
          <span className="min-w-0 truncate font-medium text-foreground">{selected.label}</span>
          {selectedAvailability !== "available" ? (
            <span
              className={cn(
                "shrink-0 text-[10px] font-medium",
                selectedAvailability === "checking"
                  ? "text-muted-foreground"
                  : "text-destructive",
              )}
            >
              {selectedAvailability === "checking" ? "checking…" : "disconnected"}
            </span>
          ) : null}
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
