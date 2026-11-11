"use client";

import type { ReactNode } from "react";
import {
  XIcon,
  DatabaseIcon,
  WandSparklesIcon,
} from "lucide-react";
import { KadyFileIcon } from "@/components/file-icon";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { Database } from "@/components/database-selector";
import type { Skill } from "@/lib/use-skills";

const DOMAIN_COLORS: Record<
  string,
  { bg: string; text: string; border: string; dot: string }
> = {
  science: {
    bg: "bg-violet-500/10",
    text: "text-violet-600 dark:text-violet-400",
    border: "border-violet-500/20",
    dot: "bg-violet-500",
  },
  finance: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-500/20",
    dot: "bg-emerald-500",
  },
};

function Chip({
  children,
  onRemove,
  ariaLabel,
  className,
  tooltip,
}: {
  children: ReactNode;
  onRemove: () => void;
  ariaLabel: string;
  className?: string;
  tooltip?: ReactNode;
}) {
  const body = (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-current/60 opacity-60 transition-all hover:bg-destructive/10 hover:!text-destructive group-hover:opacity-100"
        aria-label={ariaLabel}
      >
        <XIcon className="size-2.5" />
      </button>
    </div>
  );
  if (!tooltip) return body;
  return <InfoTooltip content={tooltip}>{body}</InfoTooltip>;
}

export interface ContextChipsBarProps {
  attachedFiles: string[];
  onRemoveFile: (path: string) => void;
  selectedDbs: Database[];
  onDbsChange: (dbs: Database[]) => void;
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
}

/**
 * Renders a single row of dismissible chips representing every piece of
 * active context for the next message (files, data sources, skills). Hidden
 * entirely when there's nothing to show.
 */
export function ContextChipsBar({
  attachedFiles,
  onRemoveFile,
  selectedDbs,
  onDbsChange,
  selectedSkills,
  onSkillsChange,
}: ContextChipsBarProps) {
  const hasAny =
    attachedFiles.length > 0 ||
    selectedDbs.length > 0 ||
    selectedSkills.length > 0;

  if (!hasAny) return null;

  const removeSkill = (id: string) =>
    onSkillsChange(selectedSkills.filter((s) => s.id !== id));
  const removeDb = (id: string) =>
    onDbsChange(selectedDbs.filter((d) => d.id !== id));

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
      {/* File attachments */}
      {attachedFiles.map((path) => {
        const name = path.split("/").pop() ?? path;
        return (
          <Chip
            key={`file:${path}`}
            onRemove={() => onRemoveFile(path)}
            ariaLabel={`Remove ${name}`}
            className="border-border/70 bg-muted/60 text-foreground/80 hover:bg-muted"
            tooltip={
              <>
                <b>{name}</b>
                <br />
                <span className="opacity-80">{path}</span>
                <br />
                Attached to the next message. The agent can read this file
                directly from the sandbox.
              </>
            }
          >
            <KadyFileIcon name={name} className="size-3" />
            <span className="max-w-[140px] truncate">{name}</span>
          </Chip>
        );
      })}

      {/* Data sources */}
      {selectedDbs.map((db) => {
        const c = DOMAIN_COLORS[db.domain];
        return (
          <Chip
            key={`db:${db.id}`}
            onRemove={() => removeDb(db.id)}
            ariaLabel={`Remove ${db.name}`}
            className={cn(c.bg, c.text, c.border)}
            tooltip={
              <>
                <b>{db.name}</b>{" "}
                <span className="opacity-70 capitalize">· {db.domain}</span>
                <br />
                {db.description}
                <br />
                <span className="opacity-70">{db.url}</span>
              </>
            }
          >
            <DatabaseIcon className="size-3 shrink-0 opacity-70" />
            <span className={cn("inline-block size-1.5 rounded-full", c.dot)} />
            <span className="max-w-[140px] truncate">{db.name}</span>
          </Chip>
        );
      })}

      {/* Skills */}
      {selectedSkills.map((skill) => (
        <Chip
          key={`skill:${skill.id}`}
          onRemove={() => removeSkill(skill.id)}
          ariaLabel={`Remove ${skill.name}`}
          className="bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20"
          tooltip={
            <>
              <b>Skill · {skill.name}</b>
              {skill.author ? (
                <span className="opacity-70"> by {skill.author}</span>
              ) : null}
              <br />
              {skill.description}
              <br />
              The expert will follow this skill&apos;s instructions for the
              next message.
            </>
          }
        >
          <WandSparklesIcon className="size-3 shrink-0 opacity-70" />
          <span className="max-w-[160px] truncate">{skill.name}</span>
        </Chip>
      ))}
    </div>
  );
}
