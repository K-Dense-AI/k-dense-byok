"use client";
import { useState } from "react";
import {
  LightbulbIcon, FlaskConicalIcon, BarChart3Icon, SignpostIcon, StickyNoteIcon,
  ChevronRightIcon, FileIcon, ExternalLinkIcon, StarIcon, MessageSquareIcon,
  MessageSquareTextIcon, CornerDownRightIcon, RotateCcwIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { rawFileUrl, fileCategory } from "@/lib/use-sandbox";
import { agentAccent, roleLabel } from "@/lib/notebook-filters";
import type { ThreadInfo } from "@/lib/notebook-threads";
import type { NotebookAnnotation } from "@/lib/notebook-annotations";
import type { NotebookEntry, NotebookEntryType } from "@/lib/notebook";

export const TYPE_META: Record<
  NotebookEntryType,
  { label: string; Icon: typeof LightbulbIcon; spine: string; chip: string }
> = {
  hypothesis: { label: "Hypothesis", Icon: LightbulbIcon, spine: "bg-amber-400", chip: "text-amber-600 dark:text-amber-400" },
  method: { label: "Method", Icon: FlaskConicalIcon, spine: "bg-blue-400", chip: "text-blue-600 dark:text-blue-400" },
  observation: { label: "Observation", Icon: BarChart3Icon, spine: "bg-emerald-400", chip: "text-emerald-600 dark:text-emerald-400" },
  decision: { label: "Decision", Icon: SignpostIcon, spine: "bg-purple-400", chip: "text-purple-600 dark:text-purple-400" },
  note: { label: "Note", Icon: StickyNoteIcon, spine: "bg-neutral-400", chip: "text-neutral-500" },
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
          className="inline-flex items-center gap-0.5"
          aria-label={`Confidence: ${level}`}
          role="img"
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-2 w-1.5 rounded-sm ${i < meta.filled ? meta.color : "bg-muted"}`}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>Confidence: {level}</TooltipContent>
    </Tooltip>
  );
}

const STATUS_META = {
  open: "border text-muted-foreground",
  supported: "border border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  refuted: "border border-rose-500/50 text-rose-600 dark:text-rose-400",
} as const;

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
  const [commentDraft, setCommentDraft] = useState("");
  const codeFilePath = entry.artifacts?.[0];
  const showOpenAsFile = Boolean(entry.code && codeFilePath && CODE_FILE_RE.test(codeFilePath));
  const superseded = Boolean(thread?.supersededBy);
  const status = entry.type === "hypothesis" ? thread?.status : undefined;
  const imageArtifacts = (entry.artifacts ?? []).filter((p) => fileCategory(p) === "image");
  const otherArtifacts = (entry.artifacts ?? []).filter((p) => fileCategory(p) !== "image");

  function submitComment() {
    const body = commentDraft.trim();
    if (!body || !onAddComment) return;
    onAddComment(entry.id, body);
    setCommentDraft("");
  }

  return (
    <div data-testid={`nb-entry-${entry.id}`} data-nb-type={entry.type}>
      <div className={`rounded-lg border bg-card p-3 shadow-sm ${superseded ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2 text-xs">
          <meta.Icon className={`size-4 shrink-0 ${meta.chip}`} />
          <span className={`font-medium ${meta.chip}`}>{meta.label}</span>
          {agentBadge !== undefined && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={`size-1.5 rounded-full ${agentAccent(entry.role ?? "agent").dot}`} />
              {roleLabel(agentBadge)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            {status && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_META[status]}`}>
                {status}
              </span>
            )}
            {entry.confidence && <ConfidenceMeter level={entry.confidence} />}
            {onTogglePin && (
              <button
                type="button"
                onClick={() => onTogglePin(entry.id)}
                title={pinned ? "Unpin entry" : "Pin entry"}
                aria-label={pinned ? "Unpin entry" : "Pin entry"}
                className="text-muted-foreground hover:text-foreground"
              >
                <StarIcon className={`size-3.5 ${pinned ? "fill-amber-400 text-amber-500" : ""}`} />
              </button>
            )}
            {onJumpToChat && (
              <button
                type="button"
                onClick={() => onJumpToChat(entry.id)}
                title="View in chat"
                aria-label="View in chat"
                className="text-muted-foreground hover:text-foreground"
              >
                <MessageSquareTextIcon className="size-3.5" />
              </button>
            )}
          </span>
        </div>
        <h4 className={`mt-1 text-sm font-semibold ${superseded ? "line-through decoration-muted-foreground/50" : ""}`}>
          {entry.title}
        </h4>
        {(entry.relatesTo || entry.supersedes || thread?.supersededBy) && (
          <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
            {entry.relatesTo && (
              <button
                type="button"
                className="flex items-center gap-1 hover:text-foreground"
                onClick={() => onJumpToEntry?.(entry.relatesTo!)}
              >
                <CornerDownRightIcon className="size-3 shrink-0" />
                <span>
                  {entry.stance === "supports" ? "supports" : entry.stance === "refutes" ? "refutes" : "re:"}{" "}
                  <span className="underline decoration-dotted underline-offset-2">
                    {relatedEntry?.title ?? entry.relatesTo}
                  </span>
                </span>
              </button>
            )}
            {entry.supersedes && (
              <button
                type="button"
                className="flex items-center gap-1 hover:text-foreground"
                onClick={() => onJumpToEntry?.(entry.supersedes!)}
              >
                <RotateCcwIcon className="size-3 shrink-0" />
                <span>
                  amends{" "}
                  <span className="underline decoration-dotted underline-offset-2">
                    {supersedesEntry?.title ?? entry.supersedes}
                  </span>
                </span>
              </button>
            )}
            {thread?.supersededBy && (
              <button
                type="button"
                className="flex items-center gap-1 text-rose-600 hover:text-rose-500 dark:text-rose-400"
                onClick={() => onJumpToEntry?.(thread.supersededBy!)}
              >
                <RotateCcwIcon className="size-3 shrink-0" />
                <span>
                  superseded by{" "}
                  <span className="underline decoration-dotted underline-offset-2">
                    {supersededByEntry?.title ?? thread.supersededBy}
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
        {entry.body && (
          <div className="mt-1 text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <MessageResponse>{entry.body}</MessageResponse>
          </div>
        )}
        {entry.code && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setCodeOpen((o) => !o)}
              >
                <ChevronRightIcon className={`size-3 transition-transform ${codeOpen ? "rotate-90" : ""}`} />
                {entry.code.lang ?? "code"}
              </button>
              {showOpenAsFile && (
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenFile(codeFilePath!)}
                >
                  <ExternalLinkIcon className="size-3" />
                  Open as file
                </button>
              )}
            </div>
            {codeOpen && (
              <div className="mt-1 text-xs [&_pre]:my-0">
                <MessageResponse>
                  {"```" + (entry.code.lang ?? "") + "\n" + entry.code.source + "\n```"}
                </MessageResponse>
              </div>
            )}
          </div>
        )}
        {entry.tags && entry.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {entry.tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTagClick?.(t)}
                className="rounded-full border bg-muted/50 px-1.5 py-0 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                #{t}
              </button>
            ))}
          </div>
        )}
        {imageArtifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imageArtifacts.map((p) => (
              <button
                key={p}
                onClick={() => onOpenFile(p)}
                title={p}
                className="group overflow-hidden rounded border bg-muted/30 hover:border-foreground/30"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={rawFileUrl(p)}
                  alt={p.split("/").pop() ?? p}
                  loading="lazy"
                  className="max-h-28 max-w-48 object-contain"
                />
                <span className="block truncate px-1.5 py-0.5 text-left text-[10px] text-muted-foreground group-hover:text-foreground">
                  {p.split("/").pop()}
                </span>
              </button>
            ))}
          </div>
        )}
        {otherArtifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {otherArtifacts.map((p) => (
              <button
                key={p}
                onClick={() => onOpenFile(p)}
                title={p}
                className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <FileIcon className="size-3 shrink-0" />
                <span className="truncate">{p.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}
        {(onAddComment || (comments && comments.length > 0)) && (
          <div className="mt-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setCommentsOpen((o) => !o)}
            >
              <MessageSquareIcon className="size-3" />
              {comments?.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "Comment"}
            </button>
            {commentsOpen && (
              <div className="mt-1 space-y-1.5 border-l-2 border-amber-400/60 pl-2">
                {(comments ?? []).map((c) => (
                  <div key={c.id} className="text-xs">
                    <span className="font-medium text-amber-600 dark:text-amber-400">You</span>{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                    <div className="text-muted-foreground">{c.body}</div>
                  </div>
                ))}
                {onAddComment && (
                  <input
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitComment();
                    }}
                    placeholder="Add a comment… (Enter to save)"
                    aria-label="Add a comment"
                    className="w-full rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-foreground/30"
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
