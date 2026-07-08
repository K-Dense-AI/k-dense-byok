"use client";
import { useMemo } from "react";
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
import type { NotebookEntry } from "@/lib/notebook";

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
  return (
    <div className="relative motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 [content-visibility:auto] [contain-intrinsic-size:auto_11rem]">
      <span
        className={`absolute -left-[21px] top-3 size-2.5 rounded-full ring-2 ring-background ${TYPE_META[entry.type].spine}`}
        aria-hidden
      />
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
  );
}

function Divider({ item }: { item: Exclude<TimelineItem, { kind: "entry" }> }) {
  if (item.kind === "day") {
    return (
      <div className="-ml-6 flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {item.label}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (item.kind === "run") {
    return (
      <div className="-ml-6 flex items-center gap-2 py-0.5 text-[10px] text-muted-foreground/70">
        <span className="h-px flex-1 border-t border-dashed border-border" />
        new run
        <span className="h-px flex-1 border-t border-dashed border-border" />
      </div>
    );
  }
  return (
    <div className="-ml-6 border-t pt-2 text-xs font-medium">
      {item.name}
    </div>
  );
}

/** Rail container: continuous vertical line the entry nodes sit on. */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative space-y-3 pl-6 before:absolute before:bottom-1 before:left-[7px] before:top-1 before:w-px before:bg-border">
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
  viewMode: "agents" | "chrono";
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
    if (chrono) return [];
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
  }, [chrono, entries]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No entries match the current filters.
      </div>
    );
  }

  const motionProps = reducedMotion
    ? ({ initial: "instant", resize: "instant" } as const)
    : {};

  return (
    <Conversation {...motionProps} className="flex-1">
      <ConversationContent className="gap-0 space-y-4 p-4">
        {chrono ? (
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
            <details key={lane.role} open className="rounded-lg border">
              <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium">
                <span className={`size-2 rounded-full ${lane.accent.dot}`} aria-hidden />
                {lane.label}
                <span className="text-muted-foreground">{lane.count}</span>
              </summary>
              <div className="p-3 pt-0">
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
