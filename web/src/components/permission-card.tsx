"use client";

import { memo, useState } from "react";
import { ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiFetch, useProjectScopeId } from "@/lib/projects";
import type { ActivityItem } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

/** Payload the data guard attaches to a `permission_request` frame. */
export interface PermissionPayload {
  toolCallId?: string;
  toolName?: string;
  command?: string;
  reason?: string;
  outcome?: string;
}

export function parsePermissionPayload(args: unknown): PermissionPayload {
  if (!args || typeof args !== "object") return {};
  const record = args as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  return {
    toolCallId: str("toolCallId"),
    toolName: str("toolName"),
    command: str("command"),
    reason: str("reason"),
    outcome: str("outcome"),
  };
}

const OUTCOME_LABEL: Record<string, string> = {
  allowed: "Allowed",
  denied: "Denied",
  timeout: "No answer — blocked",
  cancelled: "Run stopped — blocked",
  no_ui: "Blocked",
};

/**
 * The data guard paused a destructive shell command and is waiting for the
 * user. Rendered inline from the run's activities, like the interview form.
 */
export const PermissionCard = memo(function PermissionCard({
  item,
  sessionId,
  projectId,
}: {
  item: ActivityItem;
  sessionId: string | null;
  projectId?: string;
}) {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const payload = parsePermissionPayload(item.args);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const pending = item.status === "running";
  const outcome = payload.outcome ?? (item.status === "error" ? "denied" : undefined);

  const answer = async (allow: boolean) => {
    if (!sessionId || busy) return;
    setBusy(allow ? "allow" : "deny");
    try {
      const response = await apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(item.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allow }),
        },
        scopedProjectId,
      );
      if (!response.ok) {
        toast.error(
          response.status === 404
            ? "This request is no longer waiting for an answer."
            : "Couldn't send your decision. Try again.",
        );
      }
    } catch {
      toast.error("Couldn't send your decision. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className={cn(
        "my-2 w-full rounded-lg border px-3 py-2 text-sm",
        pending ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-muted/40",
      )}
      data-permission-card={item.id}
      aria-label="Permission needed"
    >
      <header className="mb-1 flex items-center gap-2 text-xs font-medium">
        <ShieldAlertIcon className="size-3.5 shrink-0" />
        <span>{pending ? "Kady wants to run a destructive command" : "Destructive command"}</span>
        {outcome && (
          <span className="ml-auto rounded bg-background/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {OUTCOME_LABEL[outcome] ?? outcome}
          </span>
        )}
      </header>
      {payload.reason && <p className="mb-1 text-xs text-muted-foreground">{payload.reason}</p>}
      {payload.command && (
        <pre className="max-h-40 overflow-auto rounded bg-background/70 px-2 py-1.5 font-mono text-[12px] leading-snug">
          <code>{payload.command}</code>
        </pre>
      )}
      {pending && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void answer(true)}>
            {busy === "allow" ? "Allowing…" : "Allow once"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void answer(false)}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Protected data (e.g. <code>user_data/</code>) is never touched either way.
          </span>
        </div>
      )}
    </section>
  );
});
