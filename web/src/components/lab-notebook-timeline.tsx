"use client";
import { useMemo } from "react";
import { ChevronDownIcon, NetworkIcon, SearchXIcon, SparklesIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { LabNotebookEntryCard, TYPE_META } from "./lab-notebook-entry-card";
import { buildTimeline, type TimelineItem } from "@/lib/notebook-timeline";
import { agentAccent, roleLabel } from "@/lib/notebook-filters";
import type { ThreadInfo } from "@/lib/notebook-threads";
import type { NotebookAnnotation } from "@/lib/notebook-annotations";
import type { NotebookEntry, NotebookEntryType } from "@/lib/notebook";
import { cn } from "@/lib/utils";

const STORY_PHASES: {
  type: NotebookEntryType;
  title: string;
  description: string;
}[] = [
  {
    type: "hypothesis",
    title: "Questions & hypotheses",
    description: "What the team thinks might be true",
  },
  {
    type: "method",
    title: "Methods & experiments",
    description: "What was tried and how",
  },
  {
    type: "observation",
    title: "Findings & evidence",
    description: "What the work revealed",
  },
  {
    type: "decision",
    title: "Decisions & direction",
    description: "What changed because of the evidence",
  },
  {
    type: "note",
    title: "Researcher notes",
    description: "Context and annotations added by the team",
  },
];

export interface TimelineCallbacks {
  onOpenFile: (path: string) => void;
  onTogglePin?: (id: string) => void;
  onAddComment?: (id: string, body: string) => void;
  onJumpToChat?: (id: string) => void;
  onJumpToEntry: (id: string) => void;
  onTagClick: (tag: string) => void;
}

function EntryRow({
  entry,
  showAgentBadge,
  ctx,
}: {
  entry: NotebookEntry;
  showAgentBadge: boolean;
  ctx: {
    threads: ReadonlyMap<string, ThreadInfo>;
    entryById: ReadonlyMap<string, NotebookEntry>;
    pinnedIds: ReadonlySet<string>;
    commentsByEntry: ReadonlyMap<string, NotebookAnnotation[]>;
    canAnnotate: boolean;
    cb: TimelineCallbacks;
  };
}) {
  const thread = ctx.threads.get(entry.id);
  const isUserNote = entry.role === "you";
  const meta = TYPE_META[entry.type];
  return (
    <div className="relative motion-safe:animate-in motion-safe:fade-in">
      <span
        className={cn(
          "absolute -left-[26px] top-2.5 flex size-5 items-center justify-center rounded-full border bg-background",
          meta.surface,
        )}
        aria-hidden
      >
        <meta.Icon className={cn("size-2.5", meta.chip)} />
      </span>
      {/* `content-visibility` implies paint containment, so it has to sit on a
          wrapper *inside* the positioning context — on the outer element it
          clips the rail node, which hangs off the left edge. */}
      <div className="[contain-intrinsic-size:auto_11rem] [content-visibility:auto]">
        <LabNotebookEntryCard
          entry={entry}
          onOpenFile={ctx.cb.onOpenFile}
          thread={thread}
          relatedEntry={entry.relatesTo ? ctx.entryById.get(entry.relatesTo) : undefined}
          supersedesEntry={entry.supersedes ? ctx.entryById.get(entry.supersedes) : undefined}
          supersededByEntry={
            thread?.supersededBy ? ctx.entryById.get(thread.supersededBy) : undefined
          }
          agentBadge={showAgentBadge ? (entry.role ?? "agent") : undefined}
          pinned={ctx.pinnedIds.has(entry.id)}
          onTogglePin={ctx.canAnnotate && !isUserNote ? ctx.cb.onTogglePin : undefined}
          comments={ctx.commentsByEntry.get(entry.id)}
          onAddComment={ctx.canAnnotate && !isUserNote ? ctx.cb.onAddComment : undefined}
          onJumpToChat={!isUserNote ? ctx.cb.onJumpToChat : undefined}
          onJumpToEntry={ctx.cb.onJumpToEntry}
          onTagClick={ctx.cb.onTagClick}
        />
      </div>
    </div>
  );
}

function Divider({ item }: { item: Exclude<TimelineItem, { kind: "entry" }> }) {
  if (item.kind === "day") {
    return (
      <div className="-ml-8 flex items-center gap-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <span className="shrink-0">{item.label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (item.kind === "run") {
    return (
      <div className="-ml-8 flex items-center gap-2 py-0.5 text-[10px] text-muted-foreground/70">
        <span className="inline-flex shrink-0 items-center gap-1">
          <SparklesIcon className="size-3" />
          new run
        </span>
        <span className="h-px flex-1 border-t border-dashed border-border" />
      </div>
    );
  }
  return (
    <div className="-ml-8 flex items-center gap-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <NetworkIcon className="size-3 shrink-0" />
      <span className="truncate">{item.name}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Rail container: continuous vertical hairline the entry nodes sit on. */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex flex-col gap-3 pl-8 before:absolute before:bottom-1 before:left-[15px] before:top-1 before:w-px before:bg-border">
      {children}
    </div>
  );
}

export function LabNotebookTimeline({
  entries,
  viewMode,
  scope,
  sessionNames,
  threads,
  entryById,
  pinnedIds,
  commentsByEntry,
  canAnnotate,
  callbacks,
  reducedMotion,
}: {
  /** Already filtered, time-sorted. */
  entries: NotebookEntry[];
  viewMode: "story" | "agents" | "chrono";
  scope: "session" | "project";
  sessionNames?: ReadonlyMap<string, string>;
  threads: ReadonlyMap<string, ThreadInfo>;
  entryById: ReadonlyMap<string, NotebookEntry>;
  pinnedIds: ReadonlySet<string>;
  commentsByEntry: ReadonlyMap<string, NotebookAnnotation[]>;
  canAnnotate: boolean;
  callbacks: TimelineCallbacks;
  reducedMotion: boolean;
}) {
  const ctx = { threads, entryById, pinnedIds, commentsByEntry, canAnnotate, cb: callbacks };
  const chrono = viewMode === "chrono" || scope === "project";
  const story = viewMode === "story" && scope === "session";

  const chronoItems = useMemo(
    () =>
      chrono
        ? buildTimeline(entries, {
            withSessionDividers: scope === "project",
            sessionNames,
          })
        : [],
    [chrono, entries, scope, sessionNames],
  );

  // By-agent lanes: lead first, then by earliest entry. Day dividers only
  // (run/session dividers are chronological-view concepts).
  const lanes = useMemo(() => {
    if (chrono || story) return [];
    const byRole = new Map<string, NotebookEntry[]>();
    for (const e of entries) {
      const role = e.role ?? "agent";
      const list = byRole.get(role);
      if (list) list.push(e);
      else byRole.set(role, [e]);
    }
    const roles = [...byRole.keys()].sort((a, b) => {
      if (a === "agent") return -1;
      if (b === "agent") return 1;
      return (byRole.get(a)![0]?.timestamp ?? 0) - (byRole.get(b)![0]?.timestamp ?? 0);
    });
    return roles.map((role) => ({
      role,
      label: roleLabel(role),
      accent: agentAccent(role),
      items: buildTimeline(byRole.get(role)!).filter((i) => i.kind !== "run"),
      count: byRole.get(role)!.length,
    }));
  }, [chrono, entries, story]);

  const storyPhases = useMemo(() => {
    if (!story) return [];
    return STORY_PHASES.map((phase) => ({
      ...phase,
      entries: entries.filter((entry) => entry.type === phase.type),
    })).filter((phase) => phase.entries.length > 0);
  }, [entries, story]);
  const storyHasMultipleAuthors = useMemo(
    () => new Set(entries.map((entry) => entry.role ?? "agent")).size > 1,
    [entries],
  );

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <SearchXIcon className="size-7 text-muted-foreground/40" />
        <p className="text-xs font-medium">No matching entries</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Try another entry type, tag, or search phrase.
        </p>
      </div>
    );
  }

  const motionProps = story
    ? ({ initial: false, resize: "instant" } as const)
    : reducedMotion
      ? ({ initial: "instant", resize: "instant" } as const)
      : {};

  return (
    <Conversation key={`${scope}:${viewMode}`} {...motionProps} className="flex-1">
      <ConversationContent className="@container/story flex flex-col gap-3 p-3">
        {story ? (
          <div className="grid items-start gap-3 @4xl/story:grid-cols-2">
            {storyPhases.map((phase) => {
              const meta = TYPE_META[phase.type];
              return (
                <section
                  key={phase.type}
                  className={cn(
                    "overflow-hidden rounded-xl border bg-card",
                    phase.type === "note" && "@4xl/story:col-span-2",
                  )}
                >
                  <div className="flex items-center gap-2 border-b px-3 py-2">
                    <meta.Icon className={cn("size-3.5 shrink-0", meta.chip)} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold">{phase.title}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {phase.description}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {phase.entries.length}
                    </span>
                  </div>
                  <div className="bg-muted/20 p-3">
                    <Rail>
                      {phase.entries.map((entry) => (
                        <EntryRow
                          key={entry.id}
                          entry={entry}
                          showAgentBadge={storyHasMultipleAuthors || entry.role === "you"}
                          ctx={ctx}
                        />
                      ))}
                    </Rail>
                  </div>
                </section>
              );
            })}
          </div>
        ) : chrono ? (
          <Rail>
            {chronoItems.map((item) =>
              item.kind === "entry" ? (
                <EntryRow
                  key={item.entry.id}
                  entry={item.entry}
                  showAgentBadge
                  ctx={ctx}
                />
              ) : (
                <Divider key={item.key} item={item} />
              ),
            )}
          </Rail>
        ) : lanes.length === 1 ? (
          <Rail>
            {lanes[0].items.map((item) =>
              item.kind === "entry" ? (
                <EntryRow key={item.entry.id} entry={item.entry} showAgentBadge={false} ctx={ctx} />
              ) : (
                <Divider key={item.key} item={item} />
              ),
            )}
          </Rail>
        ) : (
          lanes.map((lane) => (
            <details
              key={lane.role}
              open
              className="group/lane overflow-hidden rounded-xl border bg-card"
            >
              <summary className="flex cursor-pointer list-none select-none items-center gap-2 px-3 py-2 text-xs font-semibold transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <span className={cn("size-1.5 shrink-0 rounded-full", lane.accent.dot)} aria-hidden />
                <span className="truncate">{lane.label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal tabular-nums text-muted-foreground">
                  {lane.count}
                </span>
                <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground transition-transform group-open/lane:rotate-180" />
              </summary>
              <div className="border-t bg-muted/20 p-3">
                <Rail>
                  {lane.items.map((item) =>
                    item.kind === "entry" ? (
                      <EntryRow
                        key={item.entry.id}
                        entry={item.entry}
                        showAgentBadge={false}
                        ctx={ctx}
                      />
                    ) : (
                      <Divider key={item.key} item={item} />
                    ),
                  )}
                </Rail>
              </div>
            </details>
          ))
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
