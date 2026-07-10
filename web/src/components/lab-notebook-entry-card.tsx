"use client";

import { useState } from "react";
import {
  BarChart3Icon,
  ChevronRightIcon,
  Code2Icon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  FileIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
  SignpostIcon,
  StarIcon,
  StickyNoteIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentAccent, roleLabel } from "@/lib/notebook-filters";
import type { NotebookAnnotation } from "@/lib/notebook-annotations";
import type { NotebookEntry, NotebookEntryType } from "@/lib/notebook";
import type { ThreadInfo } from "@/lib/notebook-threads";
import { cn } from "@/lib/utils";
import { fileCategory, rawFileUrl } from "@/lib/use-sandbox";

export const TYPE_META: Record<
  NotebookEntryType,
  {
    label: string;
    Icon: typeof LightbulbIcon;
    spine: string;
    chip: string;
    border: string;
    wash: string;
    iconSurface: string;
  }
> = {
  hypothesis: {
    label: "Hypothesis",
    Icon: LightbulbIcon,
    spine: "bg-amber-400",
    chip: "text-amber-700 dark:text-amber-300",
    border: "border-amber-500/25",
    wash: "from-amber-500/10",
    iconSurface: "border-amber-500/25 bg-amber-500/10",
  },
  method: {
    label: "Method",
    Icon: FlaskConicalIcon,
    spine: "bg-blue-400",
    chip: "text-blue-700 dark:text-blue-300",
    border: "border-blue-500/25",
    wash: "from-blue-500/10",
    iconSurface: "border-blue-500/25 bg-blue-500/10",
  },
  observation: {
    label: "Observation",
    Icon: BarChart3Icon,
    spine: "bg-emerald-400",
    chip: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-500/25",
    wash: "from-emerald-500/10",
    iconSurface: "border-emerald-500/25 bg-emerald-500/10",
  },
  decision: {
    label: "Decision",
    Icon: SignpostIcon,
    spine: "bg-purple-400",
    chip: "text-purple-700 dark:text-purple-300",
    border: "border-purple-500/25",
    wash: "from-purple-500/10",
    iconSurface: "border-purple-500/25 bg-purple-500/10",
  },
  note: {
    label: "Note",
    Icon: StickyNoteIcon,
    spine: "bg-neutral-400",
    chip: "text-neutral-600 dark:text-neutral-300",
    border: "border-neutral-500/20",
    wash: "from-neutral-500/8",
    iconSurface: "border-neutral-500/20 bg-neutral-500/10",
  },
};

const CODE_FILE_RE = /\.(py|r|jl|sh|ts|js|ipynb|sql)$/i;

const CONFIDENCE_META = {
  low: { filled: 1, color: "bg-rose-400" },
  medium: { filled: 2, color: "bg-amber-400" },
  high: { filled: 3, color: "bg-emerald-500" },
} as const;

function ConfidenceMeter({ level }: { level: "low" | "medium" | "high" }) {
  const meta = CONFIDENCE_META[level];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-5 items-end gap-0.5 rounded-full border bg-background/70 px-1.5 py-1"
          aria-label={`Confidence: ${level}`}
          role="img"
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={cn(
                "w-1 rounded-sm",
                index === 0 ? "h-1.5" : index === 1 ? "h-2" : "h-2.5",
                index < meta.filled ? meta.color : "bg-muted",
              )}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>Confidence: {level}</TooltipContent>
    </Tooltip>
  );
}

const STATUS_META = {
  open: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  supported:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  refuted: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

function displayTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const extension = name.includes(".") ? name.split(".").pop() : "file";
  return (extension ?? "file").toUpperCase();
}

export function LabNotebookEntryCard({
  entry,
  onOpenFile,
  thread,
  relatedEntry,
  supersedesEntry,
  supersededByEntry,
  agentBadge,
  pinned,
  onTogglePin,
  comments,
  onAddComment,
  onJumpToChat,
  onJumpToEntry,
  onTagClick,
}: {
  entry: NotebookEntry;
  onOpenFile: (path: string) => void;
  thread?: ThreadInfo;
  /** Resolved target of entry.relatesTo, when present in the visible set. */
  relatedEntry?: NotebookEntry;
  /** Resolved target of entry.supersedes. */
  supersedesEntry?: NotebookEntry;
  /** Resolved entry that supersedes this one. */
  supersededByEntry?: NotebookEntry;
  /** Role badge shown in chronological view. */
  agentBadge?: string;
  pinned?: boolean;
  onTogglePin?: (entryId: string) => void;
  comments?: NotebookAnnotation[];
  onAddComment?: (entryId: string, body: string) => void;
  onJumpToChat?: (entryId: string) => void;
  onJumpToEntry?: (entryId: string) => void;
  onTagClick?: (tag: string) => void;
}) {
  const meta = TYPE_META[entry.type];
  const [codeOpen, setCodeOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const codeFilePath = entry.artifacts?.[0];
  const showOpenAsFile = Boolean(entry.code && codeFilePath && CODE_FILE_RE.test(codeFilePath));
  const superseded = Boolean(thread?.supersededBy);
  const status = entry.type === "hypothesis" ? thread?.status : undefined;
  const imageArtifacts = (entry.artifacts ?? []).filter(
    (path) => fileCategory(path) === "image",
  );
  const otherArtifacts = (entry.artifacts ?? []).filter(
    (path) => fileCategory(path) !== "image",
  );
  const hasFooter = Boolean(onAddComment || comments?.length);
  const bodyCollapsible = (entry.body?.length ?? 0) > 420;
  const supportingEvidence =
    thread?.incoming?.filter((incoming) => incoming.stance === "supports").length ?? 0;
  const challengingEvidence =
    thread?.incoming?.filter((incoming) => incoming.stance === "refutes").length ?? 0;

  function submitComment() {
    const body = commentDraft.trim();
    if (!body || !onAddComment) return;
    onAddComment(entry.id, body);
    setCommentDraft("");
  }

  return (
    <div data-testid={`nb-entry-${entry.id}`} data-nb-type={entry.type}>
      <Card
        className={cn(
          "group/card relative gap-0 overflow-hidden py-0 shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md",
          meta.border,
          pinned && "ring-1 ring-amber-400/40",
          superseded && "opacity-60",
        )}
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-br via-transparent to-transparent opacity-80",
            meta.wash,
          )}
          aria-hidden
        />

        <CardHeader className="relative gap-2 px-4 pb-0 pt-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant="outline"
              className={cn("h-6 gap-1.5 bg-background/70 backdrop-blur", meta.iconSurface, meta.chip)}
            >
              <meta.Icon data-icon="inline-start" />
              {meta.label}
            </Badge>
            {agentBadge !== undefined && (
              <Badge variant="secondary" className="h-5 max-w-40 gap-1 text-[10px] font-normal">
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", agentAccent(entry.role ?? "agent").dot)}
                />
                <span className="truncate">{roleLabel(agentBadge)}</span>
              </Badge>
            )}
            <time
              className="shrink-0 text-[10px] text-muted-foreground"
              dateTime={new Date(entry.timestamp).toISOString()}
              title={new Date(entry.timestamp).toLocaleString()}
            >
              {displayTime(entry.timestamp)}
            </time>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {status && (
                <Badge
                  variant="outline"
                  className={cn("h-5 text-[9px] uppercase tracking-wider", STATUS_META[status])}
                >
                  {status}
                </Badge>
              )}
              {entry.confidence && <ConfidenceMeter level={entry.confidence} />}
              {onTogglePin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onTogglePin(entry.id)}
                  title={pinned ? "Unpin entry" : "Pin entry"}
                  aria-label={pinned ? "Unpin entry" : "Pin entry"}
                  className="rounded-full text-muted-foreground"
                >
                  <StarIcon className={cn(pinned && "fill-amber-400 text-amber-500")} />
                </Button>
              )}
              {onJumpToChat && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onJumpToChat(entry.id)}
                  title="View in chat"
                  aria-label="View in chat"
                  className="rounded-full text-muted-foreground"
                >
                  <MessageSquareTextIcon />
                </Button>
              )}
            </span>
          </div>

          <CardTitle
            className={cn(
              "text-[15px] leading-snug tracking-tight",
              superseded && "line-through decoration-muted-foreground/50",
            )}
          >
            {entry.title}
          </CardTitle>

          {(entry.relatesTo || entry.supersedes || thread?.supersededBy) && (
            <div className="flex flex-col gap-1 text-xs">
              {entry.relatesTo && (
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted",
                    entry.stance === "supports" &&
                      "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
                    entry.stance === "refutes" &&
                      "border-rose-500/25 bg-rose-500/5 text-rose-700 dark:text-rose-300",
                    (!entry.stance || entry.stance === "neutral") && "text-muted-foreground",
                  )}
                  onClick={() => onJumpToEntry?.(entry.relatesTo!)}
                >
                  <CornerDownRightIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    {entry.stance === "supports"
                      ? "supports"
                      : entry.stance === "refutes"
                        ? "refutes"
                        : "re:"}{" "}
                    <span className="font-medium underline decoration-dotted underline-offset-2">
                      {relatedEntry?.title ?? entry.relatesTo}
                    </span>
                  </span>
                </button>
              )}
              {entry.supersedes && (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => onJumpToEntry?.(entry.supersedes!)}
                >
                  <RotateCcwIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    amends{" "}
                    <span className="font-medium underline decoration-dotted underline-offset-2">
                      {supersedesEntry?.title ?? entry.supersedes}
                    </span>
                  </span>
                </button>
              )}
              {thread?.supersededBy && (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded-md border border-rose-500/25 bg-rose-500/5 px-2 py-1 text-left text-rose-700 transition-colors hover:bg-rose-500/10 dark:text-rose-300"
                  onClick={() => onJumpToEntry?.(thread.supersededBy!)}
                >
                  <RotateCcwIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    superseded by{" "}
                    <span className="font-medium underline decoration-dotted underline-offset-2">
                      {supersededByEntry?.title ?? thread.supersededBy}
                    </span>
                  </span>
                </button>
              )}
            </div>
          )}

          {entry.type === "hypothesis" && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background/55 px-2.5 py-1.5 text-[10px]">
              <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                Evidence trail
              </span>
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {supportingEvidence} support{supportingEvidence === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                <span className="size-1.5 rounded-full bg-rose-500" />
                {challengingEvidence} challenge{challengingEvidence === 1 ? "" : "s"}
              </span>
              {supportingEvidence + challengingEvidence === 0 && (
                <span className="text-muted-foreground">Awaiting linked evidence</span>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="relative flex flex-col gap-3 px-4 pb-3 pt-2.5">
          {entry.body && (
            <div className="flex flex-col items-start gap-1">
              <div
                className={cn(
                  "relative w-full text-sm leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                  bodyCollapsible && !detailsOpen && "max-h-28 overflow-hidden",
                )}
              >
                <MessageResponse>{entry.body}</MessageResponse>
                {bodyCollapsible && !detailsOpen && (
                  <span
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent"
                    aria-hidden
                  />
                )}
              </div>
              {bodyCollapsible && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-ml-2 text-muted-foreground"
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                >
                  <ChevronRightIcon
                    data-icon="inline-start"
                    className={cn("transition-transform", detailsOpen && "rotate-90")}
                  />
                  {detailsOpen ? "Collapse entry" : "Read full entry"}
                </Button>
              )}
            </div>
          )}

          {entry.code && (
            <div className="overflow-hidden rounded-lg border bg-muted/25">
              <div className="flex items-center gap-1 p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setCodeOpen((open) => !open)}
                  aria-expanded={codeOpen}
                  className="text-muted-foreground"
                >
                  <ChevronRightIcon
                    data-icon="inline-start"
                    className={cn("transition-transform", codeOpen && "rotate-90")}
                  />
                  <Code2Icon />
                  {entry.code.lang ?? "code"}
                </Button>
                {showOpenAsFile && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenFile(codeFilePath!)}
                    className="ml-auto text-muted-foreground"
                  >
                    <ExternalLinkIcon data-icon="inline-start" />
                    Open as file
                  </Button>
                )}
              </div>
              {codeOpen && (
                <div className="border-t bg-background/60 px-2 py-1 text-xs [&_pre]:my-0">
                  <MessageResponse>
                    {"```" +
                      (entry.code.lang ?? "") +
                      "\n" +
                      entry.code.source +
                      "\n```"}
                  </MessageResponse>
                </div>
              )}
            </div>
          )}

          {imageArtifacts.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {imageArtifacts.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => onOpenFile(path)}
                  title={path}
                  className={cn(
                    "group/image relative overflow-hidden rounded-lg border bg-muted/30 text-left transition-all hover:border-foreground/25 hover:shadow-sm",
                    imageArtifacts.length % 2 === 1 && index === 0 && "col-span-2",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={rawFileUrl(path)}
                    alt={path.split("/").pop() ?? path}
                    loading="lazy"
                    className="h-40 w-full bg-white object-contain p-1 transition-transform duration-300 group-hover/image:scale-[1.01]"
                  />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-5 text-[10px] text-white">
                    {path.split("/").pop()}
                  </span>
                </button>
              ))}
            </div>
          )}

          {otherArtifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherArtifacts.map((path) => (
                <Button
                  key={path}
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onOpenFile(path)}
                  title={path}
                  className="max-w-full justify-start bg-background/60"
                >
                  <FileIcon data-icon="inline-start" />
                  <span className="truncate">{path.split("/").pop()}</span>
                  <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                    {fileExtension(path)}
                  </span>
                </Button>
              ))}
            </div>
          )}

          {entry.tags && entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => onTagClick?.(tag)}
                  className="h-5 rounded-full px-2 text-[10px] font-normal text-muted-foreground"
                >
                  #{tag}
                </Button>
              ))}
            </div>
          )}
        </CardContent>

        {hasFooter && (
          <CardFooter className="flex-col items-stretch gap-2 border-t bg-muted/20 px-4 py-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="w-fit px-1 text-muted-foreground"
              onClick={() => setCommentsOpen((open) => !open)}
              aria-expanded={commentsOpen}
            >
              <MessageSquareIcon data-icon="inline-start" />
              {comments?.length
                ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
                : "Comment"}
              <ChevronRightIcon
                data-icon="inline-end"
                className={cn("transition-transform", commentsOpen && "rotate-90")}
              />
            </Button>
            {commentsOpen && (
              <div className="flex flex-col gap-2 border-l-2 border-amber-400/60 pl-3">
                {(comments ?? []).map((comment) => (
                  <div key={comment.id} className="text-xs">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-medium text-amber-700 dark:text-amber-300">You</span>
                      <time className="text-[10px] text-muted-foreground">
                        {new Date(comment.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="mt-0.5 text-muted-foreground">{comment.body}</p>
                  </div>
                ))}
                {onAddComment && (
                  <Input
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitComment();
                    }}
                    placeholder="Add a comment…"
                    aria-label="Add a comment"
                    className="h-8 bg-background text-xs shadow-none"
                  />
                )}
              </div>
            )}
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
