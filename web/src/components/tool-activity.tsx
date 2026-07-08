"use client";

import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  FileEditIcon,
  FileIcon,
  FilePlusIcon,
  FolderTreeIcon,
  SearchIcon,
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
import { skillNameFromRead } from "@/lib/skill-invocation";
import type { ActivityItem } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

function iconFor(toolName?: string) {
  switch (toolName) {
    case "bash":
      return TerminalIcon;
    case "read":
      return FileIcon;
    case "write":
      return FilePlusIcon;
    case "edit":
      return FileEditIcon;
    case "grep":
    case "find":
      return SearchIcon;
    case "ls":
      return FolderTreeIcon;
    case "subagent":
      return UsersIcon;
    default:
      return WrenchIcon;
  }
}

/** One-line human summary of a tool call's arguments. */
function summarize(toolName: string | undefined, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const firstLine = (v: unknown) =>
      typeof v === "string" ? v.split("\n")[0] : "";
    if (toolName === "bash" && typeof a.command === "string")
      return firstLine(a.command);
    const pathish = a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query;
    if (typeof pathish === "string") return pathish;
    if (toolName === "subagent") {
      const agent = typeof a.agent === "string" ? `${a.agent}: ` : "";
      return agent + (firstLine(a.task ?? a.prompt ?? a.description) || "subtask");
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
  const Icon = skill ? WandSparklesIcon : iconFor(item.toolName);
  const name = skill ? "skill" : (item.toolName ?? item.label);
  const summary = skill ?? summarize(item.toolName, item.args);
  const args = fullArgs(item.args);
  const hasDetail = Boolean(args || item.result);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
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
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
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
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
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
