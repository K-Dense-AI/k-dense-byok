"use client";

import type { ReactNode } from "react";
import {
  XIcon,
  DatabaseIcon,
  ZapIcon,
  MonitorIcon,
  WandSparklesIcon,
  ChromeIcon,
  GlobeIcon,
} from "lucide-react";
import { KadyFileIcon } from "@/components/file-icon";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { Database } from "@/components/database-selector";
import type { ModalInstance } from "@/components/compute-selector";
import type { Skill } from "@/lib/use-skills";
import {
  useBrowserUseSettings,
  useChromeProfiles,
  type BrowserUseConfig,
} from "@/lib/use-settings";
import { profileLabel } from "@/components/browser-selector";

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

const TIER_BADGE: Record<string, string> = {
  local: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  cpu: "text-slate-600 dark:text-slate-400 bg-slate-500/10 border-slate-500/20",
  budget: "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/20",
  mid: "text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/20",
  high: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
  flagship: "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/20",
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
  selectedCompute: ModalInstance | null;
  onComputeChange: (instance: ModalInstance | null) => void;
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
}

/**
 * Renders a single row of dismissible chips representing every piece of
 * active context for the next message (files, data sources, compute, skills,
 * browser). Hidden entirely when there's nothing to show.
 */
export function ContextChipsBar({
  attachedFiles,
  onRemoveFile,
  selectedDbs,
  onDbsChange,
  selectedCompute,
  onComputeChange,
  selectedSkills,
  onSkillsChange,
}: ContextChipsBarProps) {
  const bu = useBrowserUseSettings();
  const profiles = useChromeProfiles();

  const browserEnabled = bu.config.enabled;
  const hasAny =
    attachedFiles.length > 0 ||
    selectedDbs.length > 0 ||
    selectedCompute !== null ||
    selectedSkills.length > 0 ||
    browserEnabled;

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

      {/* Compute */}
      {selectedCompute && (
        <Chip
          onRemove={() => onComputeChange(null)}
          ariaLabel={`Remove ${selectedCompute.label} compute`}
          className={cn(
            TIER_BADGE[selectedCompute.tier] ?? TIER_BADGE.budget,
          )}
          tooltip={
            <>
              <b>Modal compute · {selectedCompute.label}</b>
              <br />
              {selectedCompute.description}
              <br />
              {selectedCompute.vram ? `${selectedCompute.vram}GB VRAM · ` : ""}
              ${selectedCompute.pricePerHour}/hr while running. The expert
              will be instructed to run heavy code on this instance.
            </>
          }
        >
          <ZapIcon className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{selectedCompute.label}</span>
          {selectedCompute.vram && (
            <span className="opacity-70">{selectedCompute.vram}GB</span>
          )}
          <span className="opacity-70 tabular-nums">
            ${selectedCompute.pricePerHour}/hr
          </span>
        </Chip>
      )}

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

      {/* Browser */}
      {browserEnabled && (
        <BrowserChip
          config={bu.config}
          onDisable={() => bu.save({ enabled: false })}
          profileNameLookup={(id) => profileLabel(id, profiles.profiles)}
        />
      )}
    </div>
  );
}

function BrowserChip({
  config,
  onDisable,
  profileNameLookup,
}: {
  config: BrowserUseConfig;
  onDisable: () => void;
  profileNameLookup: (profileId: string | null) => string | null;
}) {
  const usingRealChrome = Boolean(config.profile);
  const Icon = usingRealChrome ? ChromeIcon : GlobeIcon;
  const label = usingRealChrome
    ? (profileNameLookup(config.profile) ?? "Real Chrome")
    : config.headed
      ? "Headed Chromium"
      : "Headless Chromium";

  return (
    <Chip
      onRemove={onDisable}
      ariaLabel="Disable browser"
      className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
      tooltip={
        <>
          <b>Browser automation · {label}</b>
          <br />
          {usingRealChrome
            ? "The agent will drive your real Chrome — cookies, logins, and extensions included. Close Chrome first."
            : config.headed
              ? "A visible Chromium window launches so you can watch the agent browse."
              : "Chromium runs headless in the background. Fastest, but you won't see it."}
        </>
      }
    >
      <Icon className="size-3 shrink-0 opacity-80" />
      {usingRealChrome && (
        <MonitorIcon className="size-3 shrink-0 opacity-60" />
      )}
      <span className="max-w-[160px] truncate">{label}</span>
    </Chip>
  );
}
