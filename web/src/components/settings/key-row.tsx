"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRightIcon, KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/projects";
import { notifyProviderAuthChanged } from "@/lib/use-provider-auth";
import { cn } from "@/lib/utils";
import { SettingsError } from "./primitives";

export type CredentialStatus = Record<string, { set: boolean; masked: string | null }>;

export interface KeyDef {
  /** Key into the `/credentials` status map. */
  id: string;
  bodyField: string;
  label: string;
  placeholder: string;
  keysUrl?: string;
  hint: string;
  /** Name of the service, for the sign-up link's accessible name (defaults to `label`). */
  service?: string;
  /** Password input + masked echo (default). Configuration values are shown in full. */
  secret?: boolean;
  /** Saving changes which model-picker sections exist, so re-probe providers. */
  notifyProviders?: boolean;
  /** Replaces the default confirmation shown after a save. */
  savedNote?: string;
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/**
 * Where to sign up for a credential: a small pill that names the site it
 * opens, so a user knows where they are going before they click.
 */
export function GetKeyLink({
  href,
  service,
  label = "Get a key",
  className,
}: {
  href: string;
  /** What the key is for, read out by screen readers ("Exa API key"). */
  service?: string;
  label?: string;
  className?: string;
}) {
  const host = hostOf(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Opens ${host} in a new tab`}
      aria-label={`${label}${service ? ` (${service})` : ""} at ${host}, opens in a new tab`}
      className={cn(
        "group inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[10px] leading-4 text-muted-foreground transition-colors",
        "hover:border-primary/30 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <KeyRoundIcon className="size-3 shrink-0 text-primary/70" aria-hidden />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="truncate text-muted-foreground/70 group-hover:text-muted-foreground">{host}</span>
      <ArrowUpRightIcon
        className="size-3 shrink-0 opacity-60 transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:opacity-100"
        aria-hidden
      />
    </a>
  );
}

/**
 * `/credentials` status shared by the Providers and Services tabs. Each tab
 * loads it on mount; a save returns the full status map, so rows update in
 * place without a refetch.
 */
export function useCredentialStatus() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/credentials");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      setStatus((await res.json()) as CredentialStatus);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, setStatus, loading, error, reload: load };
}

export function KeyRow({
  def,
  current,
  onStatus,
}: {
  def: KeyDef;
  current: { set: boolean; masked: string | null } | undefined;
  onStatus: (status: CredentialStatus) => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { confirm, dialog } = useConfirm();

  const submit = useCallback(
    async (value: string | null) => {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const res = await apiFetch("/credentials", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [def.bodyField]: value }),
        });
        const data = (await res.json().catch(() => null)) as
          | (CredentialStatus & { detail?: string })
          | null;
        if (!res.ok) throw new Error(data?.detail || `Save failed (${res.status})`);
        if (data) onStatus(data as CredentialStatus);
        // Provider keys gate model-picker sections, so re-probe them.
        if (def.notifyProviders) notifyProviderAuthChanged();
        setKeyInput("");
        setSaved(true);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [def.bodyField, def.notifyProviders, onStatus],
  );

  const secret = def.secret !== false;
  const inputId = `credential-${def.id}`;

  // Removing a key can strand open chats on a model that no longer resolves;
  // a configuration value (URL, region) just falls back to its default.
  const clear = async () => {
    if (secret) {
      const ok = await confirm({
        title: `Remove the ${def.label}?`,
        description: "New requests that rely on it will fail until you add a key again.",
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!ok) return;
    }
    await submit(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {dialog}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label htmlFor={inputId} className="shrink-0 text-xs font-medium">
          {def.label}
        </label>
        {def.keysUrl ? <GetKeyLink href={def.keysUrl} service={def.service ?? def.label} /> : null}
      </div>
      {error ? <SettingsError>{error}</SettingsError> : null}
      {current?.set && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <span>
            {secret ? "Key set" : "Set"} —{" "}
            <code className="font-mono break-all">{current.masked}</code>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-[11px] text-destructive hover:text-destructive"
            disabled={saving}
            aria-label={`Clear ${def.label}`}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type={secret ? "password" : "text"}
          value={keyInput}
          autoComplete="off"
          placeholder={
            current?.set
              ? `Replace ${secret ? "key" : "value"}${def.placeholder ? ` (${def.placeholder})` : ""}`
              : def.placeholder
          }
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setKeyInput(e.target.value);
            setSaved(false);
            // The error was about the value that was submitted, not this one.
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyInput.trim()) void submit(keyInput.trim());
          }}
        />
        <Button
          size="sm"
          className="text-xs"
          disabled={saving || !keyInput.trim()}
          onClick={() => void submit(keyInput.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {saved && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          {def.savedNote ?? "Saved. New runs use it immediately — no restart needed."}
        </p>
      )}
      {def.hint ? (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{def.hint}</p>
      ) : null}
    </div>
  );
}
