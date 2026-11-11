"use client";

import { memo, useMemo, useState } from "react";
import {
  ActivityIcon,
  BellIcon,
  CheckCircle2Icon,
  MessageCircleQuestionIcon,
  ScissorsIcon,
  ShieldAlertIcon,
  TerminalSquareIcon,
} from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";
import type { ChatMessage } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

/**
 * Notices a Pi extension injected into the conversation (pi-subagents
 * supervisor requests, watchdog findings, background completions, slash
 * command output) and Kady's own compaction marker. Rendered full-width
 * between the chat bubbles.
 */

export interface SystemCardKind {
  label: string;
  Icon: typeof BellIcon;
  tone: "info" | "warning" | "success" | "muted";
}

export function systemCardKind(customType: string | undefined, content?: string): SystemCardKind {
  switch (customType) {
    case "subagent_supervisor_request":
      return { label: "Subagent needs a decision", Icon: MessageCircleQuestionIcon, tone: "info" };
    case "subagent_watchdog_warning":
      return { label: "Watchdog warning", Icon: ShieldAlertIcon, tone: "warning" };
    case "subagent-notify":
      return { label: "Background subagent finished", Icon: CheckCircle2Icon, tone: "success" };
    case "subagent-wait-subscription":
      return { label: "Background work update", Icon: BellIcon, tone: "info" };
    case "subagent_control_notice":
      // pi-subagents' activity monitor: "Subagent needs attention: <agent>" …
      if (content && /^subagent needs attention/i.test(content)) {
        return { label: "Subagent needs attention", Icon: ActivityIcon, tone: "info" };
      }
      return { label: "Subagent notice", Icon: BellIcon, tone: "info" };
    case "subagent_steering_notice":
      return { label: "Subagent notice", Icon: BellIcon, tone: "info" };
    case "subagent-slash-text-result":
      return { label: "Command output", Icon: TerminalSquareIcon, tone: "muted" };
    case "compaction":
      return { label: "Context compacted", Icon: ScissorsIcon, tone: "muted" };
    default:
      return { label: "Notice", Icon: BellIcon, tone: "info" };
  }
}

const TONE_CLASSES: Record<SystemCardKind["tone"], string> = {
  info: "border-sky-500/30 bg-sky-500/5",
  warning: "border-amber-500/40 bg-amber-500/10",
  success: "border-emerald-500/30 bg-emerald-500/5",
  muted: "border-border bg-muted/40",
};

/** Details worth a chip, with a human label. Everything else (ids, reply
 * hints for the model, intercom targets, text already in the body) is hidden. */
const DETAIL_LABELS: Record<string, string> = {
  agent: "Specialist",
  reason: "Reason",
  category: "Category",
  confidence: "Confidence",
  source: "Source",
  status: "Status",
  state: "State",
  outcome: "Outcome",
  runId: "Run",
  durationMs: "Duration",
  stalemateRepeats: "Repeats",
  sessionLabel: "Session",
  handoffPath: "Result",
};
const MONO_DETAILS = new Set(["runId", "handoffPath"]);

export const COLLAPSE_AFTER_LINES = 8;
export const COLLAPSE_AFTER_CHARS = 600;

function formatTokens(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : String(value ?? "");
}

function formatDetail(key: string, value: string | number | boolean): string {
  if (key === "runId" && typeof value === "string") return value.slice(0, 8);
  if (key === "durationMs" && typeof value === "number") {
    return value >= 60_000 ? `${Math.round(value / 60_000)} min` : `${Math.max(1, Math.round(value / 1000))} s`;
  }
  if (typeof value === "string") return value.replace(/_/g, " ");
  return String(value);
}

const KEY_VALUE_LINE = /^([A-Z][A-Za-z0-9][A-Za-z0-9 /()'-]{0,48}):(\s+(.+)|\s*)$/;
const BLOCK_LINE = /^(\s*[-*+]\s|\s*\d+[.)]\s|#{1,6}\s|>|\||\s{4})/;

/**
 * Extension notices are plain text: one fact per line, `Label: value` pairs,
 * dash lists, blank lines between sections. Markdown would fold the single
 * newlines into one paragraph, so make them hard breaks and bold the labels.
 * Fenced code blocks are left untouched.
 */
export function formatNoticeMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const lines = part.split("\n").map((line) => {
        if (BLOCK_LINE.test(line)) return line;
        const match = KEY_VALUE_LINE.exec(line.trim());
        if (!match) return line;
        const value = match[3];
        return value ? `**${match[1]}:** ${value}` : `**${match[1]}:**`;
      });
      // Hard break between two consecutive non-empty lines (a blank line
      // already separates paragraphs; list items break on their own).
      return lines
        .map((line, i) => {
          const next = lines[i + 1];
          if (line.trim() === "" || next === undefined || next.trim() === "" || BLOCK_LINE.test(next)) return line;
          // A plain line right after a list item would otherwise be read as a
          // lazy continuation of that item: close the list with a blank line.
          if (BLOCK_LINE.test(line)) return `${line}\n`;
          return `${line}  `;
        })
        .join("\n");
    })
    .join("");
}

/** Where to cut a long notice: after N lines, or N characters if the lines are long. */
export function collapseNotice(text: string): { collapsed: string; hiddenLines: number } | null {
  const lines = text.split("\n");
  const tooManyLines = lines.length > COLLAPSE_AFTER_LINES;
  const tooLong = text.length > COLLAPSE_AFTER_CHARS;
  if (!tooManyLines && !tooLong) return null;
  let kept = tooManyLines ? lines.slice(0, COLLAPSE_AFTER_LINES) : lines;
  let collapsed = kept.join("\n");
  if (collapsed.length > COLLAPSE_AFTER_CHARS) {
    collapsed = collapsed.slice(0, COLLAPSE_AFTER_CHARS).replace(/\s+\S*$/, "");
    kept = collapsed.split("\n");
  }
  return { collapsed: `${collapsed}…`, hiddenLines: Math.max(1, lines.length - kept.length) };
}

export const SystemCard = memo(function SystemCard({ message }: { message: ChatMessage }) {
  const kind = systemCardKind(message.customType, message.content);
  const [expanded, setExpanded] = useState(false);
  const details = message.details ?? {};

  const cut = useMemo(() => collapseNotice(message.content), [message.content]);
  const body = useMemo(
    () => formatNoticeMarkdown(cut && !expanded ? cut.collapsed : message.content),
    [cut, expanded, message.content],
  );

  if (message.customType === "compaction") {
    const tokensBefore = details.tokensBefore;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    return (
      <div
        role="separator"
        aria-label="Context compacted"
        className="my-3 flex items-center gap-3 text-[11px] text-muted-foreground"
        data-system-card="compaction"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5">
          <kind.Icon className="size-3" />
          Context compacted
          {typeof tokensBefore === "number" ? ` · ${formatTokens(tokensBefore)} tokens summarized` : ""}
          {reason && reason !== "threshold" ? ` · ${reason}` : ""}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const severity = typeof details.severity === "string" ? details.severity : undefined;
  const strip = Object.entries(details).filter(([key]) => key in DETAIL_LABELS && key !== "agent");
  const agent = typeof details.agent === "string" ? details.agent : undefined;

  return (
    <section
      className={cn("my-2 w-full rounded-lg border px-3 py-2 text-sm", TONE_CLASSES[kind.tone])}
      data-system-card={message.customType ?? "custom"}
      aria-label={kind.label}
    >
      <header className="mb-1.5 flex items-center gap-2 text-xs font-medium">
        <kind.Icon className="size-3.5 shrink-0" />
        <span>{kind.label}</span>
        {severity && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              severity === "blocker" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-amber-500/15",
            )}
          >
            {severity}
          </span>
        )}
        {agent && (
          <span className="ml-auto rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title="Specialist">
            {agent}
          </span>
        )}
      </header>
      {body && (
        <div className="text-[13px] leading-relaxed [&_li]:my-0 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:pl-4 [&_strong]:font-medium [&_strong]:text-foreground/90">
          <MessageResponse>{body}</MessageResponse>
        </div>
      )}
      {cut && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show more (${cut.hiddenLines} more line${cut.hiddenLines === 1 ? "" : "s"})`}
        </button>
      )}
      {strip.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {strip.map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-1">
              <dt className="font-medium">{DETAIL_LABELS[key]}</dt>
              <dd className={cn(MONO_DETAILS.has(key) ? "font-mono" : undefined)}>{formatDetail(key, value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
});
