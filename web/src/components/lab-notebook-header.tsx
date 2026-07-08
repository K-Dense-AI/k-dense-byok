"use client";
import { useState } from "react";
import {
  BookOpenIcon, DownloadIcon, PrinterIcon, SearchIcon, StarIcon, XIcon,
  FileTextIcon, ListIcon, UsersIcon, SparklesIcon,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { TYPE_META } from "./lab-notebook-entry-card";
import { type NotebookFilterState } from "@/lib/notebook-filters";
import type { NotebookEntryType } from "@/lib/notebook";

export type NotebookScope = "session" | "project";
export type NotebookViewMode = "agents" | "chrono";
export type NotebookExportFormat = "md" | "zip" | "json";

const ALL_TYPES: NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

function SegmentedToggle<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: { value: T; label: string; Icon?: typeof ListIcon; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          data-active={value === o.value}
          onClick={() => onChange(o.value)}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:text-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
        >
          {o.Icon && <o.Icon className="size-3" />}
          {o.label}
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
  canAnnotate,
  onExport,
  onPrint,
  methods,
}: {
  streaming: boolean;
  scope: NotebookScope;
  onScopeChange: (s: NotebookScope) => void;
  viewMode: NotebookViewMode;
  onViewModeChange: (v: NotebookViewMode) => void;
  filters: NotebookFilterState;
  onFiltersChange: (f: NotebookFilterState) => void;
  /** Counts from the search-filtered set (not type-filtered), so chips don't zero themselves. */
  typeCounts: Record<NotebookEntryType, number>;
  totalCount: number;
  filteredCount: number;
  canAnnotate: boolean;
  onExport: (format: NotebookExportFormat) => void;
  onPrint: () => void;
  methods: { enabled: boolean; busy: boolean; run: () => void };
}) {
  const [methodsOpen, setMethodsOpen] = useState(false);

  function toggleType(t: NotebookEntryType) {
    const next = new Set(filters.types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onFiltersChange({ ...filters, types: next });
  }

  const hasEntries = totalCount > 0;

  return (
    <div className="border-b">
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <BookOpenIcon className="size-4" />
        <span className="font-medium">Lab Notebook</span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            writing…
          </span>
        )}
        <SegmentedToggle
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: "session", label: "This chat" },
            { value: "project", label: "All chats" },
          ]}
        />
        <span className="text-xs text-muted-foreground">
          {filteredCount === totalCount
            ? `${totalCount} ${totalCount === 1 ? "entry" : "entries"}`
            : `${filteredCount} of ${totalCount}`}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          {scope === "session" && hasEntries && (
            <Popover open={methodsOpen} onOpenChange={setMethodsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={!methods.enabled || methods.busy}
                  className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {methods.busy ? <Spinner className="size-3" /> : <SparklesIcon className="size-3" />}
                  Methods draft
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 text-sm" align="end">
                <p className="font-medium">Draft a Methods section?</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Summarizes this notebook&apos;s method, decision, and observation entries with
                  one AI call, billed to this project&apos;s budget. The draft is saved into the
                  sandbox.
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => setMethodsOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded border bg-foreground px-2 py-1 text-xs text-background hover:opacity-90"
                    onClick={() => {
                      setMethodsOpen(false);
                      methods.run();
                    }}
                  >
                    Generate
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {hasEntries && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
                >
                  <DownloadIcon className="size-3" /> Export
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onExport("md")}>
                  <FileTextIcon /> Markdown (.md)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("zip")}>
                  <DownloadIcon /> Bundle with artifacts (.zip)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("json")}>
                  <FileTextIcon /> JSON (.json)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {hasEntries && (
            <button
              type="button"
              onClick={onPrint}
              className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
            >
              <PrinterIcon className="size-3" /> PDF
            </button>
          )}
        </span>
      </div>
      {hasEntries && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs">
          {ALL_TYPES.map((t) => {
            const m = TYPE_META[t];
            const active = filters.types.has(t);
            const count = typeCounts[t];
            if (count === 0 && !active) return null;
            return (
              <button
                key={t}
                type="button"
                data-active={active}
                onClick={() => toggleType(t)}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground hover:text-foreground data-[active=true]:border-foreground/40 data-[active=true]:bg-muted data-[active=true]:text-foreground"
              >
                <m.Icon className={`size-3 ${m.chip}`} />
                {m.label}
                <span className="text-[10px]">{count}</span>
              </button>
            );
          })}
          {canAnnotate && (
            <button
              type="button"
              data-active={filters.pinnedOnly}
              onClick={() => onFiltersChange({ ...filters, pinnedOnly: !filters.pinnedOnly })}
              title="Pinned only"
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground hover:text-foreground data-[active=true]:border-amber-500/50 data-[active=true]:bg-muted data-[active=true]:text-amber-600 dark:data-[active=true]:text-amber-400"
            >
              <StarIcon className="size-3" /> Pinned
            </button>
          )}
          <span className="relative ml-auto inline-flex items-center">
            <SearchIcon className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
            <input
              value={filters.query}
              onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
              placeholder="Search entries…"
              aria-label="Search entries"
              className="w-40 rounded-full border bg-background py-0.5 pl-6 pr-6 outline-none placeholder:text-muted-foreground/70 focus:border-foreground/30"
            />
            {filters.query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onFiltersChange({ ...filters, query: "" })}
                className="absolute right-1.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
          {scope === "session" && (
            <SegmentedToggle
              value={viewMode}
              onChange={onViewModeChange}
              options={[
                { value: "agents", label: "By agent", Icon: UsersIcon },
                { value: "chrono", label: "Timeline", Icon: ListIcon },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}
