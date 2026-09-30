"use client";

/**
 * Settings → Project → General: everything that belongs to one project,
 * as four independently-saved cards so a failing section never leaves the
 * others half-written.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  getProjectCompaction,
  getProjectGuardPolicy,
  getProjectInstructionsStatus,
  putProjectCompaction,
  putProjectGuardPolicy,
  restoreProjectInstructions,
  type CompactionSettingsResponse,
  type GuardPolicy,
  type InstructionsStatus,
  type Project,
} from "@/lib/projects";
import { notifyProjectBudgetChanged, useProjectCost } from "@/lib/use-project-cost";
import { useProjects } from "@/lib/use-projects";
import { SettingsCard, SettingsError, SettingsHeader } from "./primitives";

function formatUsd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(2)}`;
}

/** Inline "Saved" / error line plus Discard + Save buttons for one card. */
function CardActions({
  dirty,
  saving,
  saved,
  error,
  onDiscard,
  onSave,
  saveLabel = "Save",
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      <SettingsError>{error}</SettingsError>
      <div className="flex items-center justify-end gap-2">
        {saved && !dirty ? (
          <span className="mr-auto text-[11px] text-emerald-600 dark:text-emerald-400" role="status">
            Saved.
          </span>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="text-xs" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </Button>
        <Button type="button" size="sm" className="text-xs" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}

interface GeneralDraft {
  name: string;
  description: string;
  tags: string;
  /** Empty string = no limit. A string so "0." / "1." type naturally. */
  spendLimit: string;
}

function generalFrom(project: Project): GeneralDraft {
  return {
    name: project.name,
    description: project.description,
    tags: project.tags.join(", "),
    spendLimit:
      project.spendLimitUsd === null || project.spendLimitUsd === undefined ? "" : String(project.spendLimitUsd),
  };
}

function GeneralCard({ project }: { project: Project }) {
  const { update } = useProjects();
  const { summary } = useProjectCost(0, project.id);
  const [draft, setDraft] = useState(() => generalFrom(project));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt outside edits (a rename elsewhere) unless the user is mid-edit.
  const baseline = generalFrom(project);
  const baselineKey = JSON.stringify(baseline);
  const dirty = JSON.stringify(draft) !== baselineKey;
  const [seenKey, setSeenKey] = useState(baselineKey);
  if (seenKey !== baselineKey) {
    const wasClean = JSON.stringify(draft) === seenKey;
    setSeenKey(baselineKey);
    if (wasClean) setDraft(baseline);
  }

  const save = async () => {
    setError(null);
    setSaved(false);
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    const trimmedLimit = draft.spendLimit.trim();
    let spendLimitUsd: number | null = null;
    if (trimmedLimit !== "") {
      const parsed = Number(trimmedLimit);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Spend limit must be a non-negative number (or empty)");
        return;
      }
      spendLimitUsd = parsed;
    }
    setSaving(true);
    try {
      const next = await update(project.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        spendLimitUsd,
      });
      setDraft(generalFrom(next));
      setSaved(true);
      notifyProjectBudgetChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const budget = summary.budget;
  const committed = budget.committedUsd ?? budget.totalUsd;
  return (
    <SettingsCard id="general" title="General & budget">
      <div className="grid gap-3">
        <label className="grid gap-1 text-xs font-medium">
          Name
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="RNA-seq pilot"
            className="h-8 text-xs font-normal"
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Description
          <Textarea
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Optional one-line summary."
            className="text-xs font-normal"
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          <span>
            Tags <span className="font-normal text-muted-foreground">(comma separated)</span>
          </span>
          <Input
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            placeholder="genomics, proteomics"
            className="h-8 text-xs font-normal"
          />
        </label>
        <div id="budget" className="grid scroll-mt-4 gap-1">
          <label htmlFor="project-spend-limit" className="text-xs font-medium">
            Spend limit <span className="font-normal text-muted-foreground">(USD, optional)</span>
          </label>
          <Input
            id="project-spend-limit"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={draft.spendLimit}
            onChange={(e) => setDraft({ ...draft, spendLimit: e.target.value })}
            placeholder="Leave empty for no limit"
            className="h-8 text-xs"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            So far: {formatUsd(budget.spentUsd ?? summary.totalUsd)} spent
            {(budget.reservedUsd ?? 0) > 0 ? `, ${formatUsd(budget.reservedUsd)} reserved for running compute` : ""}
            {budget.limitUsd !== null ? ` — ${formatUsd(committed)} of ${formatUsd(budget.limitUsd)}` : ""}.
            Pay-as-you-go model usage, metered extra usage and Modal compute count toward the cap;
            subscription and local models don&apos;t. New billable runs are blocked once the total
            reaches it, with a warning at 80%.
          </p>
        </div>
      </div>
      <CardActions
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onDiscard={() => {
          setDraft(baseline);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </SettingsCard>
  );
}

const INSTRUCTIONS_TEXT: Record<InstructionsStatus, string> = {
  current: "Up to date with the instructions Kady ships.",
  outdated: "An older shipped version — it is upgraded automatically on the next launch.",
  edited:
    "Edited in this project, so newer shipped guidance (raw-data guard, specialist questions) is not applied automatically.",
  missing: "Missing — the agent runs without its sandbox instructions.",
};

function InstructionsCard({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<InstructionsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    getProjectInstructionsStatus(projectId)
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const restore = async () => {
    if (status === "edited") {
      const ok = await confirm({
        title: "Replace the edited AGENTS.md?",
        description:
          "Your changes to this project's AGENTS.md are overwritten with the shipped instructions. Copy anything you want to keep first.",
        confirmLabel: "Restore defaults",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await restoreProjectInstructions(projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      id="instructions"
      title="Agent instructions (AGENTS.md)"
      description="The sandbox's AGENTS.md tells the agent how to work in this project: ask before assuming, respect raw data, confirm costs before scheduling. To customize it, open this project's sandbox/AGENTS.md in a local text editor. This file is hidden from Kady's file browser."
    >
      {dialog}
      <div className="flex items-center gap-3" data-testid="instructions-status">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {status ? INSTRUCTIONS_TEXT[status] : error ? null : "Loading…"}
        </p>
        {status && status !== "current" ? (
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-[11px]" disabled={busy} onClick={() => void restore()}>
            {busy ? "Restoring…" : "Restore default instructions"}
          </Button>
        ) : null}
      </div>
      <SettingsError className="mt-2">{error}</SettingsError>
    </SettingsCard>
  );
}

function GuardCard({ projectId }: { projectId: string }) {
  const [initial, setInitial] = useState<GuardPolicy | null>(null);
  const [paths, setPaths] = useState("");
  const [destructiveConfirm, setDestructiveConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((policy: GuardPolicy) => {
    setInitial(policy);
    setPaths(policy.protectedPaths.join("\n"));
    setDestructiveConfirm(policy.destructiveConfirm);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    getProjectGuardPolicy(projectId)
      .then((policy) => {
        if (!cancelled) adopt(policy);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [adopt, projectId]);

  const protectedPaths = paths
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty = Boolean(
    initial &&
      (destructiveConfirm !== initial.destructiveConfirm ||
        protectedPaths.join("\n") !== initial.protectedPaths.join("\n")),
  );

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      adopt(await putProjectGuardPolicy(projectId, { protectedPaths, destructiveConfirm }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      id="safety"
      title="Raw-data guard"
      description="Applies to Kady and to background specialists, in open chats too. A heuristic guard, not a security boundary — see docs/data-guard.md."
    >
      {!initial ? (
        error ? <SettingsError>{error}</SettingsError> : <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        <div data-testid="guard-settings">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Protected paths (one glob per line, relative to the sandbox; the agent can read but never modify them)
            <Textarea
              rows={3}
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              placeholder={"user_data/**\nraw/*.csv"}
              aria-label="Protected paths"
              className="font-mono text-xs"
            />
          </label>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs">Ask before destructive shell commands elsewhere</span>
            <Switch
              checked={destructiveConfirm}
              onCheckedChange={setDestructiveConfirm}
              aria-label="Confirm destructive commands"
            />
          </div>
          <CardActions
            dirty={dirty}
            saving={saving}
            saved={saved}
            error={error}
            onDiscard={() => {
              adopt(initial);
              setError(null);
            }}
            onSave={() => void save()}
          />
        </div>
      )}
    </SettingsCard>
  );
}

function CompactionCard({ projectId }: { projectId: string }) {
  const [initial, setInitial] = useState<CompactionSettingsResponse | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [reserve, setReserve] = useState("");
  const [keepRecent, setKeepRecent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((settings: CompactionSettingsResponse) => {
    setInitial(settings);
    setEnabled(settings.enabled);
    setReserve(String(settings.reserveTokens));
    setKeepRecent(String(settings.keepRecentTokens));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    getProjectCompaction(projectId)
      .then((settings) => {
        if (!cancelled) adopt(settings);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [adopt, projectId]);

  const dirty = Boolean(
    initial &&
      (enabled !== initial.enabled ||
        reserve.trim() !== String(initial.reserveTokens) ||
        keepRecent.trim() !== String(initial.keepRecentTokens)),
  );

  const save = async () => {
    if (!initial) return;
    setError(null);
    setSaved(false);
    const reserveTokens = Number(reserve);
    const keepRecentTokens = Number(keepRecent);
    const { bounds } = initial;
    for (const [label, value, range] of [
      ["Reserve for the reply", reserveTokens, bounds.reserveTokens],
      ["Keep recent verbatim", keepRecentTokens, bounds.keepRecentTokens],
    ] as const) {
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        setError(`${label} must be a whole number between ${range.min.toLocaleString()} and ${range.max.toLocaleString()}.`);
        return;
      }
    }
    setSaving(true);
    try {
      adopt(await putProjectCompaction(projectId, { enabled, reserveTokens, keepRecentTokens }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      id="context"
      title="Context compaction"
      description="Compaction summarizes older messages when a conversation nears the model's context window. Kady puts its own state block (plan, notebook, results, environment) ahead of the summary. Applies to every chat in this project, including open ones; use “Compact now” in a chat to run it by hand."
    >
      {!initial ? (
        error ? <SettingsError>{error}</SettingsError> : <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        <div data-testid="compaction-settings">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">Compact automatically near the context limit</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Automatic compaction" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Reserve for the reply (tokens)
              <Input
                type="number"
                inputMode="numeric"
                min={initial.bounds.reserveTokens.min}
                max={initial.bounds.reserveTokens.max}
                step={1000}
                value={reserve}
                onChange={(e) => setReserve(e.target.value)}
                aria-label="Reserve tokens"
                className="h-8 text-xs"
              />
              <span className="text-[10px]">
                {initial.bounds.reserveTokens.min.toLocaleString()}–{initial.bounds.reserveTokens.max.toLocaleString()}
              </span>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Keep recent verbatim (tokens)
              <Input
                type="number"
                inputMode="numeric"
                min={initial.bounds.keepRecentTokens.min}
                max={initial.bounds.keepRecentTokens.max}
                step={1000}
                value={keepRecent}
                onChange={(e) => setKeepRecent(e.target.value)}
                aria-label="Keep recent tokens"
                className="h-8 text-xs"
              />
              <span className="text-[10px]">
                {initial.bounds.keepRecentTokens.min.toLocaleString()}–{initial.bounds.keepRecentTokens.max.toLocaleString()}
              </span>
            </label>
          </div>
          <CardActions
            dirty={dirty}
            saving={saving}
            saved={saved}
            error={error}
            onDiscard={() => {
              adopt(initial);
              setError(null);
            }}
            onSave={() => void save()}
          />
        </div>
      )}
    </SettingsCard>
  );
}

export function ProjectSettingsPanel({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SettingsHeader
        title={project ? `Project settings · ${project.name}` : "Project settings"}
        description="Settings that belong to this project only: its name and budget, the agent's instructions, raw-data protection, and context compaction. Each card saves on its own."
      />
      {!project ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading project…
        </p>
      ) : (
        // Remount per project so no card shows the previous project's draft.
        <div key={project.id} className="flex flex-col gap-4">
          <GeneralCard project={project} />
          <InstructionsCard projectId={project.id} />
          <GuardCard projectId={project.id} />
          <CompactionCard projectId={project.id} />
        </div>
      )}
    </div>
  );
}
