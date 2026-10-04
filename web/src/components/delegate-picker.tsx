"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  LoaderIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getAgents, type AgentFile } from "@/lib/agents";
import { openSettings } from "@/lib/settings-nav";
import { Switch } from "@/components/ui/switch";
import type { DelegationChoice } from "@/lib/composer-context";

/** The agents the lead can actually launch: enabled ones, verifiers flagged. */
function launchable(agents: AgentFile[]): AgentFile[] {
  return agents
    .filter((a) => a.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delegation for the next message: name the specialists Kady should hand work
 * to (or let it choose), and ask for a verification gate before a result is
 * accepted. Both become plain instructions appended to the message.
 */
export function DelegatePickerBody({
  value,
  onChange,
  autoFocus = false,
}: {
  value: DelegationChoice;
  onChange: (next: DelegationChoice) => void;
  autoFocus?: boolean;
}) {
  const [agents, setAgents] = useState<AgentFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    getAgents()
      .then((list) => {
        if (!cancelled) setAgents(launchable(list));
      })
      .catch((err) => {
        if (cancelled) return;
        setAgents([]);
        setError(err instanceof Error ? err.message : "Couldn't load specialists");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const verifiers = useMemo(
    () => (agents ?? []).filter((a) => a.verifier).map((a) => a.name),
    [agents],
  );

  // The verifier list is captured with the toggle; refresh it once the
  // roster arrives so a toggle flipped from a restored state names them.
  useEffect(() => {
    if (!value.verify || agents === null) return;
    if (verifiers.join(",") !== value.verifiers.join(",")) onChange({ ...value, verifiers });
  }, [agents, verifiers, value, onChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!agents || !q) return agents;
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    );
  }, [agents, search]);

  const selected = new Set(value.specialists);

  const toggleSpecialist = (name: string) => {
    const specialists = selected.has(name)
      ? value.specialists.filter((n) => n !== name)
      : [...value.specialists, name];
    onChange({ ...value, specialists, auto: false });
  };

  const toggleAuto = () =>
    onChange({ ...value, auto: !value.auto, specialists: [] });

  const setVerify = (verify: boolean) =>
    onChange({ ...value, verify, verifiers: verify ? verifiers : [] });

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus={autoFocus}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search specialists…"
          aria-label="Search specialists"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
        {!search.trim() && (
          <OptionRow
            checked={value.auto}
            onToggle={toggleAuto}
            title={
              <span className="flex items-center gap-1.5">
                <SparklesIcon className="size-3 text-primary" />
                Let Kady choose
              </span>
            }
            description="Kady splits the work and picks specialists by their descriptions."
          />
        )}
        {filtered === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderIcon className="size-3.5 animate-spin" /> Loading specialists…
          </div>
        ) : error ? (
          <div role="alert" className="px-3 py-4 text-center text-xs text-destructive">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {search.trim() ? "No matching specialists." : "No specialists are enabled for this project."}
          </div>
        ) : (
          filtered.map((agent) => (
            <OptionRow
              key={agent.name}
              checked={selected.has(agent.name)}
              onToggle={() => toggleSpecialist(agent.name)}
              title={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{agent.name}</span>
                  {agent.verifier && (
                    <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                      verifier
                    </span>
                  )}
                  {agent.model && (
                    <span className="truncate text-[10px] font-normal text-muted-foreground/70">
                      {agent.model}
                    </span>
                  )}
                </span>
              }
              description={agent.description}
            />
          ))
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 border-t px-3 py-2.5 text-xs">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">Verify before accepting</span>
          <span className="mt-0.5 block leading-relaxed text-muted-foreground/80">
            Kady has the best-suited verifier specialist
            {verifiers.length > 0 ? ` (${verifiers.length} enabled)` : ""} review the result under a
            verification gate, and accepts it only if the review passes.
          </span>
        </span>
        <Switch
          size="sm"
          checked={value.verify}
          onCheckedChange={setVerify}
          aria-label="Verify before accepting"
          className="mt-0.5"
        />
      </label>

      <div className="flex items-center justify-between gap-3 border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          Specialists run as sub-agents and are billed like any other run.
        </span>
        <button
          type="button"
          onClick={() => openSettings({ tab: "specialists" })}
          className="whitespace-nowrap text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Manage specialists
        </button>
      </div>
    </>
  );
}

function OptionRow({
  checked,
  onToggle,
  title,
  description,
}: {
  checked: boolean;
  onToggle: () => void;
  title: React.ReactNode;
  description: string;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
        checked && "bg-muted/40",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background",
        )}
      >
        {checked && <CheckIcon className="size-2.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{title}</div>
        <p className="mt-0.5 line-clamp-2 leading-relaxed text-muted-foreground/80">{description}</p>
      </div>
    </div>
  );
}
