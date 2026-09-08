"use client";

import { memo, useState } from "react";
import {
  BellIcon,
  CheckCircle2Icon,
  MessageCircleQuestionIcon,
  ScissorsIcon,
  ShieldAlertIcon,
} from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";
import type { ChatMessage } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

/**
 * Notices a Pi extension injected into the conversation (pi-subagents
 * supervisor requests, watchdog findings, background completions) and Kady's
 * own compaction marker. Rendered full-width between the chat bubbles.
 */

export interface SystemCardKind {
  label: string;
  Icon: typeof BellIcon;
  tone: "info" | "warning" | "success" | "muted";
}

export function systemCardKind(customType: string | undefined): SystemCardKind {
  switch (customType) {
    case "subagent_supervisor_request":
      return { label: "Subagent needs a decision", Icon: MessageCircleQuestionIcon, tone: "info" };
    case "subagent_watchdog_warning":
      return { label: "Watchdog warning", Icon: ShieldAlertIcon, tone: "warning" };
    case "subagent-notify":
      return { label: "Background subagent finished", Icon: CheckCircle2Icon, tone: "success" };
    case "subagent-wait-subscription":
      return { label: "Background work update", Icon: BellIcon, tone: "info" };
    case "subagent_steering_notice":
    case "subagent_control_notice":
      return { label: "Subagent notice", Icon: BellIcon, tone: "info" };
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

/** Details already expressed by the label/body; keep the strip short. */
const HIDDEN_DETAIL_KEYS = new Set(["summary", "evidence", "recommendedAction", "noticeText", "requestBody"]);
const COLLAPSE_AFTER_CHARS = 600;

function formatTokens(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : String(value ?? "");
}

export const SystemCard = memo(function SystemCard({ message }: { message: ChatMessage }) {
  const kind = systemCardKind(message.customType);
  const [expanded, setExpanded] = useState(false);
  const details = message.details ?? {};

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

  const long = message.content.length > COLLAPSE_AFTER_CHARS;
  const body = long && !expanded ? `${message.content.slice(0, COLLAPSE_AFTER_CHARS)}…` : message.content;
  const severity = typeof details.severity === "string" ? details.severity : undefined;
  const strip = Object.entries(details).filter(
    ([key]) => !HIDDEN_DETAIL_KEYS.has(key) && key !== "severity",
  );

  return (
    <section
      className={cn("my-2 w-full rounded-lg border px-3 py-2 text-sm", TONE_CLASSES[kind.tone])}
      data-system-card={message.customType ?? "custom"}
      aria-label={kind.label}
    >
      <header className="mb-1 flex items-center gap-2 text-xs font-medium">
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
        {typeof details.agent === "string" && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{details.agent}</span>
        )}
      </header>
      {body && <MessageResponse>{body}</MessageResponse>}
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {strip.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {strip.map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-1">
              <dt className="font-medium">{key}</dt>
              <dd className={cn(key === "replyHint" || key === "requestId" ? "font-mono" : undefined)}>
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
});
