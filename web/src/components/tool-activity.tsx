"use client";

import {
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  FileEditIcon,
  FileIcon,
  FilePlusIcon,
  FolderTreeIcon,
  SearchIcon,
  ServerCogIcon,
  TerminalIcon,
  UsersIcon,
  WandSparklesIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { ToolResultImages } from "@/components/scientific-result-card";
import { modalJobIdFromActivity, openModalJob } from "@/lib/modal-jobs";
import { skillNameFromRead } from "@/lib/skill-invocation";
import type { ActivityItem } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

function ToolIcon({ toolName }: { toolName?: string }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  switch (toolName) {
    case "bash":
      return <TerminalIcon className={className} />;
    case "read":
      return <FileIcon className={className} />;
    case "write":
      return <FilePlusIcon className={className} />;
    case "edit":
      return <FileEditIcon className={className} />;
    case "grep":
    case "find":
      return <SearchIcon className={className} />;
    case "ls":
      return <FolderTreeIcon className={className} />;
    case "subagent":
      return <UsersIcon className={className} />;
    default:
      return <WrenchIcon className={className} />;
  }
}

function subagentNames(
  args: Record<string, unknown>,
  result: string | undefined,
): string[] {
  const names: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !names.includes(value.trim())) {
      names.push(value.trim());
    }
  };

  add(args.agent);
  if (Array.isArray(args.tasks)) {
    for (const task of args.tasks) {
      if (task && typeof task === "object") {
        add((task as Record<string, unknown>).agent);
      }
    }
  }

  if (result) {
    const asyncNames = /^Async (?:parallel|single): \[([^\]]+)\]/m.exec(result)?.[1];
    if (asyncNames) asyncNames.split("+").forEach(add);
    for (const match of result.matchAll(
      /^(?:Step \d+|Agent \d+\/\d+):\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gm,
    )) {
      add(match[1]);
    }
  }

  return names;
}

/** One-line human summary of a tool call's arguments. */
function summarize(
  toolName: string | undefined,
  args: unknown,
  result?: string,
): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const firstLine = (v: unknown) =>
      typeof v === "string" ? v.split("\n")[0] : "";
    if (toolName === "bash" && typeof a.command === "string")
      return firstLine(a.command);
    const pathish = a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query;
    if (typeof pathish === "string") return pathish;
    if (toolName === "subagent") {
      const agents = subagentNames(a, result);
      if (agents.length > 0) {
        const task =
          agents.length === 1 && Array.isArray(a.tasks) && a.tasks.length === 1
            ? (a.tasks[0] as Record<string, unknown> | undefined)?.task
            : a.task ?? a.prompt ?? a.description;
        const detail = firstLine(task);
        return `${agents.join(" + ")}${detail ? `: ${detail}` : ""}`;
      }
      if (a.action === "list") return "list agents";
      if (a.action === "status") return "check subagent status";
      if (a.action === "interrupt") return "interrupt subagent";
      return firstLine(a.task ?? a.prompt ?? a.description) || "subtask";
    }
    const keys = Object.keys(a);
    if (keys.length) return firstLine(a[keys[0]]) || keys.join(", ");
  }
  return typeof args === "string" ? args.split("\n")[0] : "";
}

function StatusDot({ status }: { status: ActivityItem["status"] }) {
  if (status === "running") return <Spinner className="size-3 shrink-0" />;
  if (status === "error")
    return <XIcon className="size-3 shrink-0 text-destructive" />;
  return <CheckIcon className="size-3 shrink-0 text-emerald-500" />;
}

function fullArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "object") {
    const a = args as Record<string, unknown>;
    // For bash, the command alone is the most useful, verbatim payload.
    if (typeof a.command === "string" && Object.keys(a).length === 1)
      return a.command;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  return String(args);
}

function ToolCard({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  // A read of a SKILL.md is Pi's skill activation — surface the skill's name
  // instead of a generic file read (the path stays visible under Input). The
  // server resolves the frontmatter name; the path-derived name is a fallback.
  const skill = item.skillName ?? skillNameFromRead(item.toolName, item.args);
  const name = skill ? "skill" : (item.toolName ?? item.label);
  const summary = skill ?? summarize(item.toolName, item.args, item.result);
  const args = fullArgs(item.args);
  const hasDetail = Boolean(
    args ||
      item.result ||
      item.resultImages?.length ||
      item.resultImagesTruncated,
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-tool-call-id={item.id}>
      <CollapsibleTrigger
        disabled={!hasDetail}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-left text-xs transition-colors",
          hasDetail && "hover:bg-muted/60",
          item.status === "error" && "border-destructive/40",
        )}
      >
        {hasDetail ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {skill ? (
          <WandSparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ToolIcon toolName={item.toolName} />
        )}
        <span className="font-medium text-foreground">{name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        <span className={cn(!summary && "ml-auto")}>
          <StatusDot status={item.status} />
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="mt-1 space-y-1.5 rounded-md border bg-background p-2">
            {args && (
              <div>
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {item.toolName === "bash" ? "Command" : "Input"}
                </div>
                <pre className="max-h-60 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                  {args}
                </pre>
              </div>
            )}
            {item.result && (
              <div>
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {item.status === "error" ? "Error" : "Output"}
                </div>
                <pre
                  className={cn(
                    "max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
                    item.status === "error" ? "text-destructive" : "text-foreground",
                  )}
                >
                  {item.result}
                </pre>
              </div>
            )}
            <ToolResultImages
              images={item.resultImages ?? []}
              truncated={item.resultImagesTruncated}
            />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Compact pointer from Modal tool activity to its durable Compute record. */
export function ModalJobChip({
  item,
  onView,
}: {
  item: ActivityItem;
  onView?: (jobId?: string) => void;
}) {
  const jobId = modalJobIdFromActivity(item);
  const toolLabel = (item.toolName ?? "modal")
    .replace(/^modal_/, "")
    .replace(/_/g, " ");
  const view = () => {
    if (onView) onView(jobId ?? undefined);
    else openModalJob(jobId);
  };
  return (
    <div
      data-tool-call-id={item.id}
      className={cn(
        "my-1 flex w-full items-center gap-2 rounded-md border border-violet-500/25 bg-violet-500/5 px-2.5 py-1.5 text-xs",
        item.status === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <ServerCogIcon className="size-3.5 shrink-0 text-violet-500" />
      <span className="font-medium capitalize text-foreground">Modal · {toolLabel}</span>
      {jobId ? (
        <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {jobId}
        </code>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {item.status === "running" ? "Submitting durable compute…" : "Durable compute activity"}
        </span>
      )}
      <StatusDot status={item.status} />
      <button
        type="button"
        onClick={view}
        className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {jobId ? "View job" : "Open Compute"}
      </button>
    </div>
  );
}

/**
 * Compact chip for a `notebook` tool call: the entry itself renders in the
 * Lab Notebook panel, so the transcript shows a one-line pointer with an
 * optional jump ("View in notebook"). item.id === the notebook entry id.
 */
export function NotebookEntryChip({
  item,
  onView,
}: {
  item: ActivityItem;
  onView?: (entryId: string) => void;
}) {
  const args = (item.args ?? {}) as Record<string, unknown>;
  const typeLabel =
    typeof args.type === "string"
      ? args.type.charAt(0).toUpperCase() + args.type.slice(1)
      : "Entry";
  const title = typeof args.title === "string" ? args.title : "";
  return (
    <div
      data-tool-call-id={item.id}
      className="my-1 flex w-full items-center gap-2 rounded-md border border-orange-500/25 bg-orange-500/5 px-2.5 py-1.5 text-xs"
    >
      <BookOpenIcon className="size-3.5 shrink-0 text-orange-500" />
      <span className="font-medium text-foreground">Notebook · {typeLabel}</span>
      {title && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span>
      )}
      <StatusDot status={item.status} />
      {onView && (
        <button
          type="button"
          onClick={() => onView(item.id)}
          className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          View in notebook
        </button>
      )}
    </div>
  );
}

/** The collapsible list of tool calls the agent made during a turn. */
export function ToolActivityList({ activities }: { activities: ActivityItem[] }) {
  if (!activities.length) return null;
  return (
    <div className="my-1 space-y-1">
      {activities.map((a) => (
        <ToolCard key={a.id} item={a} />
      ))}
    </div>
  );
}

/** Collapsible "thinking" disclosure for an assistant message's reasoning. */
export function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        <BrainIcon className="size-3.5" />
        <span>Reasoning</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-muted pl-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {reasoning}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
