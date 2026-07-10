"use client";

import { useState } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  FlaskConicalIcon,
  ListIcon,
  MapIcon,
  PaperclipIcon,
  PrinterIcon,
  SearchIcon,
  SignpostIcon,
  SparklesIcon,
  StarIcon,
  UsersIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { TYPE_META } from "./lab-notebook-entry-card";
import { type NotebookFilterState } from "@/lib/notebook-filters";
import type { NotebookEntryType } from "@/lib/notebook";

export type NotebookScope = "session" | "project";
export type NotebookViewMode = "story" | "agents" | "chrono";
export type NotebookExportFormat = "md" | "zip" | "json";

interface NotebookHighlight {
  id: string;
  title: string;
}

export interface NotebookOverview {
  artifactCount: number;
  collaboratorCount: number;
  pinnedCount: number;
  hypotheses: { open: number; supported: number; refuted: number };
  topTags: { label: string; count: number }[];
  latestObservation?: NotebookHighlight;
  latestDecision?: NotebookHighlight;
  updatedAt?: number;
}

const ALL_TYPES: NotebookEntryType[] = [
  "hypothesis",
  "method",
  "observation",
  "decision",
  "note",
];

function relativeUpdate(timestamp?: number): string {
  if (!timestamp) return "No activity yet";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; Icon?: typeof ListIcon; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/50 p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          data-active={value === option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm"
        >
          {option.Icon && <option.Icon className="size-3" />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LabNotebookHeader({
  streaming,
  scope,
  onScopeChange,
  viewMode,
  onViewModeChange,
  filters,
  onFiltersChange,
  typeCounts,
  totalCount,
  filteredCount,
  overview,
  canAnnotate,
  onExport,
  onPrint,
  onTagClick,
  onEntryJump,
  methods,
}: {
  streaming: boolean;
  scope: NotebookScope;
  onScopeChange: (scope: NotebookScope) => void;
  viewMode: NotebookViewMode;
  onViewModeChange: (view: NotebookViewMode) => void;
  filters: NotebookFilterState;
  onFiltersChange: (filters: NotebookFilterState) => void;
  /** Counts from the search-filtered set (not type-filtered), so chips don't zero themselves. */
  typeCounts: Record<NotebookEntryType, number>;
  totalCount: number;
  filteredCount: number;
  overview: NotebookOverview;
  canAnnotate: boolean;
  onExport: (format: NotebookExportFormat) => void;
  onPrint: () => void;
  onTagClick: (tag: string) => void;
  onEntryJump: (entryId: string) => void;
  methods: { enabled: boolean; busy: boolean; run: () => void };
}) {
  const [methodsOpen, setMethodsOpen] = useState(false);

  function toggleType(type: NotebookEntryType) {
    const next = new Set(filters.types);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onFiltersChange({ ...filters, types: next });
  }

  const hasEntries = totalCount > 0;
  const hypothesisTotal =
    overview.hypotheses.open + overview.hypotheses.supported + overview.hypotheses.refuted;

  return (
    <header className="@container/notebook relative overflow-hidden border-b bg-card">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_12%_0%,color-mix(in_oklab,var(--chart-2)_18%,transparent),transparent_48%),radial-gradient(circle_at_82%_18%,color-mix(in_oklab,var(--chart-4)_12%,transparent),transparent_42%)]"
        aria-hidden
      />

      <div className="relative flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background/80 shadow-sm backdrop-blur">
              <FlaskConicalIcon className="size-5" />
              {streaming && (
                <span className="absolute -right-1 -top-1 flex size-3">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                  <span className="relative inline-flex size-3 rounded-full border-2 border-card bg-emerald-500" />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold tracking-tight">Living Lab Notebook</h2>
                {streaming ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  >
                    <ActivityIcon data-icon="inline-start" />
                    Recording live
                  </Badge>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    {relativeUpdate(overview.updatedAt)}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                Ideas, evidence, decisions, and files — captured as the research unfolds.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {scope === "session" && hasEntries && (
              <Popover open={methodsOpen} onOpenChange={setMethodsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={!methods.enabled || methods.busy}
                  >
                    {methods.busy ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <SparklesIcon data-icon="inline-start" />
                    )}
                    Methods draft
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="end">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Turn the trail into a Methods section</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Kady synthesizes the recorded methods, decisions, and observations in one
                      budgeted AI call, then saves an editable draft to the sandbox.
                    </p>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setMethodsOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => {
                        setMethodsOpen(false);
                        methods.run();
                      }}
                    >
                      <SparklesIcon data-icon="inline-start" />
                      Generate
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {hasEntries && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="xs">
                    <DownloadIcon data-icon="inline-start" />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => onExport("md")}>
                      <FileTextIcon /> Markdown (.md)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport("zip")}>
                      <DownloadIcon /> Bundle with artifacts (.zip)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport("json")}>
                      <FileTextIcon /> JSON (.json)
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {hasEntries && (
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                onClick={onPrint}
                aria-label="Save notebook as PDF"
                title="Export as PDF"
              >
                <PrinterIcon />
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedToggle
            value={scope}
            onChange={onScopeChange}
            options={[
              { value: "session", label: "This chat" },
              { value: "project", label: "All chats" },
            ]}
          />
          {scope === "session" && hasEntries && (
            <SegmentedToggle
              value={viewMode}
              onChange={onViewModeChange}
              options={[
                { value: "story", label: "Research story", Icon: MapIcon },
                { value: "agents", label: "By agent", Icon: UsersIcon },
                { value: "chrono", label: "Timeline", Icon: ListIcon },
              ]}
            />
          )}
          <span className="text-xs text-muted-foreground">
            {filteredCount === totalCount
              ? `${totalCount} ${totalCount === 1 ? "entry" : "entries"}`
              : `${filteredCount} of ${totalCount} entries`}
          </span>
        </div>

        {hasEntries && (
          <div className="overflow-hidden rounded-xl border bg-background/70 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]">
                <MapIcon className="size-3.5 text-muted-foreground" />
                Research map
              </span>
              <span className="text-[10px] text-muted-foreground">
                {totalCount} recorded · {relativeUpdate(overview.updatedAt).replace("Updated ", "")}
              </span>
              <span className="ml-auto inline-flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <UsersIcon className="size-3" />
                  {overview.collaboratorCount} contributor
                  {overview.collaboratorCount === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <PaperclipIcon className="size-3" />
                  {overview.artifactCount} artifact{overview.artifactCount === 1 ? "" : "s"}
                </span>
                {overview.pinnedCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                    <StarIcon className="size-3 fill-current" />
                    {overview.pinnedCount} pinned
                  </span>
                )}
              </span>
            </div>

            <div className="grid @3xl/notebook:grid-cols-[minmax(0,1.2fr)_minmax(16rem,.8fr)]">
              <div className="relative flex min-w-0 items-center overflow-x-auto px-3 py-3">
                {(
                  [
                    ["hypothesis", "Questions"],
                    ["method", "Methods"],
                    ["observation", "Findings"],
                    ["decision", "Decisions"],
                  ] as const
                ).map(([type, label], index) => {
                  const meta = TYPE_META[type];
                  return (
                    <div key={type} className="flex min-w-0 flex-1 items-center">
                      <button
                        type="button"
                        onClick={() =>
                          onFiltersChange({ ...filters, types: new Set([type]) })
                        }
                        className="group/stage flex min-w-20 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
                        aria-label={`Show ${label.toLowerCase()}`}
                      >
                        <span
                          className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-transform group-hover/stage:-translate-y-0.5",
                            meta.iconSurface,
                            meta.chip,
                          )}
                        >
                          <meta.Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-base font-semibold leading-none tabular-nums">
                            {typeCounts[type]}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {label}
                          </span>
                        </span>
                      </button>
                      {index < 3 && (
                        <ArrowRightIcon className="mx-0.5 size-3 shrink-0 text-border" aria-hidden />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col gap-1 border-t bg-muted/15 p-2 @3xl/notebook:border-l @3xl/notebook:border-t-0">
                {overview.latestDecision ? (
                  <button
                    type="button"
                    onClick={() => onEntryJump(overview.latestDecision!.id)}
                    className="group/highlight flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-purple-500/25 bg-purple-500/10 text-purple-700 dark:text-purple-300">
                      <SignpostIcon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Current direction
                      </span>
                      <span className="block truncate text-xs font-medium">
                        Direction · {overview.latestDecision.title}
                      </span>
                    </span>
                    <ArrowRightIcon className="size-3 text-muted-foreground transition-transform group-hover/highlight:translate-x-0.5" />
                  </button>
                ) : null}
                {overview.latestObservation ? (
                  <button
                    type="button"
                    onClick={() => onEntryJump(overview.latestObservation!.id)}
                    className="group/highlight flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                      <ActivityIcon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Latest signal
                      </span>
                      <span className="block truncate text-xs font-medium">
                        Signal · {overview.latestObservation.title}
                      </span>
                    </span>
                    <ArrowRightIcon className="size-3 text-muted-foreground transition-transform group-hover/highlight:translate-x-0.5" />
                  </button>
                ) : null}
                {!overview.latestDecision && !overview.latestObservation && (
                  <div className="flex min-h-12 items-center px-2 text-xs text-muted-foreground">
                    Findings and decisions will surface here as the story develops.
                  </div>
                )}
              </div>
            </div>

            {(hypothesisTotal > 0 || overview.topTags.length > 0) && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t px-3 py-1.5">
                {hypothesisTotal > 0 && (
                  <>
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Evidence
                    </span>
                    <Badge variant="ghost" className="h-5 text-[10px] text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2Icon data-icon="inline-start" />
                      {overview.hypotheses.supported} supported
                    </Badge>
                    <Badge variant="ghost" className="h-5 text-[10px] text-amber-700 dark:text-amber-300">
                      <ActivityIcon data-icon="inline-start" />
                      {overview.hypotheses.open} open
                    </Badge>
                    <Badge variant="ghost" className="h-5 text-[10px] text-rose-700 dark:text-rose-300">
                      <XCircleIcon data-icon="inline-start" />
                      {overview.hypotheses.refuted} refuted
                    </Badge>
                  </>
                )}
                {overview.topTags.length > 0 && (
                  <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Focus
                    </span>
                    {overview.topTags.map((tag) => (
                      <Button
                        key={tag.label}
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-5 rounded-full px-1.5 text-[10px] text-muted-foreground"
                        onClick={() => onTagClick(tag.label)}
                      >
                        #{tag.label}
                        <span>{tag.count}</span>
                      </Button>
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {hasEntries && (
        <div className="relative flex flex-wrap items-center gap-1.5 border-t bg-background/75 px-4 py-2 text-xs backdrop-blur">
          {ALL_TYPES.map((type) => {
            const meta = TYPE_META[type];
            const active = filters.types.has(type);
            const count = typeCounts[type];
            if (count === 0 && !active) return null;
            return (
              <button
                key={type}
                type="button"
                data-active={active}
                aria-pressed={active}
                onClick={() => toggleType(type)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border bg-background px-2 text-muted-foreground transition-all hover:-translate-y-px hover:text-foreground hover:shadow-sm",
                  "data-[active=true]:border-foreground/30 data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=true]:shadow-sm",
                )}
              >
                <meta.Icon className={cn("size-3", meta.chip)} />
                {meta.label}
                <span className="text-[10px]">{count}</span>
              </button>
            );
          })}
          {canAnnotate && (
            <button
              type="button"
              data-active={filters.pinnedOnly}
              aria-pressed={filters.pinnedOnly}
              onClick={() =>
                onFiltersChange({ ...filters, pinnedOnly: !filters.pinnedOnly })
              }
              title="Pinned only"
              className="inline-flex h-6 items-center gap-1 rounded-full border bg-background px-2 text-muted-foreground transition-all hover:-translate-y-px hover:text-foreground hover:shadow-sm data-[active=true]:border-amber-500/50 data-[active=true]:bg-amber-500/10 data-[active=true]:text-amber-700 dark:data-[active=true]:text-amber-300"
            >
              <StarIcon className="size-3" /> Pinned
            </button>
          )}
          <span className="relative ml-auto inline-flex min-w-36 flex-1 items-center @xl/notebook:max-w-56">
            <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(event) =>
                onFiltersChange({ ...filters, query: event.target.value })
              }
              placeholder="Search entries…"
              aria-label="Search entries"
              className="h-7 rounded-full bg-background pl-8 pr-7 text-xs shadow-none"
            />
            {filters.query && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => onFiltersChange({ ...filters, query: "" })}
                className="absolute right-0.5 size-6 rounded-full text-muted-foreground"
              >
                <XIcon />
              </Button>
            )}
          </span>
        </div>
      )}
    </header>
  );
}
