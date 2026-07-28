"use client";

import { useState } from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  ListIcon,
  MapIcon,
  PrinterIcon,
  SearchIcon,
  SignpostIcon,
  SparklesIcon,
  StarIcon,
  UsersIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
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
  if (!timestamp) return "no activity yet";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/**
 * Two-state (or three-state) switch. Mirrors the scope switch in
 * `modal-jobs-panel.tsx` so the two pinned panels read as one family.
 */
function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; Icon?: typeof ListIcon; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center rounded-md border bg-muted/20 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.Icon && <option.Icon className="size-3" />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One-line jump to the newest decision / observation. */
function Highlight({
  kind,
  title,
  onClick,
}: {
  kind: "direction" | "signal";
  title: string;
  onClick: () => void;
}) {
  const Icon = kind === "direction" ? SignpostIcon : ActivityIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon
        className={cn(
          "size-3 shrink-0",
          kind === "direction"
            ? "text-violet-600 dark:text-violet-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      />
      {/* Label and title share one text node so the header highlight doesn't
          shadow the entry card's own title in text queries. */}
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/70">
          {kind === "direction" ? "Direction" : "Signal"}
        </span>{" "}
        · {title}
      </span>
    </button>
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
  canExport,
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
  /** False when the scope has no exportable target (session scope, no chat yet). */
  canExport: boolean;
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
  const hasMeta =
    Boolean(overview.latestDecision || overview.latestObservation) ||
    hypothesisTotal > 0 ||
    overview.topTags.length > 0;

  // Subtitle carries what the removed stats card used to spell out, in the
  // same "one muted line under the panel title" slot every panel header uses.
  const subtitle = hasEntries
    ? [
        `${totalCount} ${totalCount === 1 ? "entry" : "entries"}`,
        overview.collaboratorCount > 1
          ? `${overview.collaboratorCount} contributors`
          : null,
        overview.artifactCount > 0
          ? `${overview.artifactCount} artifact${overview.artifactCount === 1 ? "" : "s"}`
          : null,
        relativeUpdate(overview.updatedAt),
      ]
        .filter(Boolean)
        .join(" · ")
    : "Ideas, evidence, and decisions as the research unfolds";

  return (
    <header className="@container/notebook shrink-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpenIcon className="size-4 shrink-0 text-orange-500" />
          <div className="min-w-0">
            <h1 className="text-xs font-semibold">Lab Notebook</h1>
            <p className="truncate text-[10px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        {streaming && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            Recording
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={!canExport}
                  title={
                    canExport
                      ? undefined
                      : "Start a chat before exporting its notebook"
                  }
                >
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

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5">
        <SegmentedToggle
          label="Notebook scope"
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: "session", label: "This chat" },
            { value: "project", label: "All chats" },
          ]}
        />
        {scope === "session" && hasEntries && (
          <SegmentedToggle
            label="Notebook layout"
            value={viewMode}
            onChange={onViewModeChange}
            options={[
              { value: "story", label: "Research story", Icon: MapIcon },
              { value: "agents", label: "By agent", Icon: UsersIcon },
              { value: "chrono", label: "Timeline", Icon: ListIcon },
            ]}
          />
        )}
        {hasEntries && filteredCount !== totalCount && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {filteredCount} of {totalCount} shown
          </span>
        )}
      </div>

      {hasEntries && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5">
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
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  "data-[active=true]:border-foreground/25 data-[active=true]:bg-muted data-[active=true]:text-foreground",
                )}
              >
                <meta.Icon className={cn("size-3", meta.chip)} />
                {meta.label}
                <span className="tabular-nums text-muted-foreground">{count}</span>
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
              className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:border-amber-500/40 data-[active=true]:bg-amber-500/10 data-[active=true]:text-amber-600 dark:data-[active=true]:text-amber-400"
            >
              <StarIcon className="size-3" /> Pinned
              {overview.pinnedCount > 0 && (
                <span className="tabular-nums">{overview.pinnedCount}</span>
              )}
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
              className="h-6 rounded-full bg-background pl-8 pr-7 text-[11px] shadow-none"
            />
            {filters.query && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => onFiltersChange({ ...filters, query: "" })}
                className="absolute right-0.5 size-5 rounded-full text-muted-foreground"
              >
                <XIcon />
              </Button>
            )}
          </span>
        </div>
      )}

      {hasEntries && hasMeta && (
        <div className="flex flex-col gap-1 border-b px-4 py-1.5 text-[10px] text-muted-foreground">
          {(overview.latestDecision || overview.latestObservation) && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3">
              {overview.latestDecision && (
                <Highlight
                  kind="direction"
                  title={overview.latestDecision.title}
                  onClick={() => onEntryJump(overview.latestDecision!.id)}
                />
              )}
              {overview.latestObservation && (
                <Highlight
                  kind="signal"
                  title={overview.latestObservation.title}
                  onClick={() => onEntryJump(overview.latestObservation!.id)}
                />
              )}
            </div>
          )}
          {(hypothesisTotal > 0 || overview.topTags.length > 0) && (
            <div className="flex min-w-0 items-center gap-x-3">
              {hypothesisTotal > 0 && (
                <span className="inline-flex shrink-0 items-center gap-2 tabular-nums">
                  <span
                    className="inline-flex items-center gap-1"
                    title={`${overview.hypotheses.supported} supported`}
                  >
                    <CheckCircle2Icon className="size-3 text-emerald-600 dark:text-emerald-400" />
                    {overview.hypotheses.supported}
                  </span>
                  <span
                    className="inline-flex items-center gap-1"
                    title={`${overview.hypotheses.open} open`}
                  >
                    <ActivityIcon className="size-3 text-amber-600 dark:text-amber-400" />
                    {overview.hypotheses.open}
                  </span>
                  <span
                    className="inline-flex items-center gap-1"
                    title={`${overview.hypotheses.refuted} refuted`}
                  >
                    <XCircleIcon className="size-3 text-rose-600 dark:text-rose-400" />
                    {overview.hypotheses.refuted}
                  </span>
                </span>
              )}
              {overview.topTags.length > 0 && (
                <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
                  {overview.topTags.map((tag) => (
                    <button
                      key={tag.label}
                      type="button"
                      onClick={() => onTagClick(tag.label)}
                      className="shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                    >
                      #{tag.label} <span className="tabular-nums">{tag.count}</span>
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
