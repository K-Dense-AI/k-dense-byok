"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/projects";
import { notifyProviderAuthChanged } from "@/lib/use-provider-auth";
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
  /** Password input + masked echo (default). Configuration values are shown in full. */
  secret?: boolean;
  /** Saving changes which model-picker sections exist, so re-probe providers. */
  notifyProviders?: boolean;
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
      <div className="flex items-baseline gap-2">
        <label htmlFor={inputId} className="text-xs font-medium">
          {def.label}
        </label>
        {def.keysUrl ? (
          <a
            href={def.keysUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground hover:underline"
          >
            Get a key ↗
          </a>
        ) : null}
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
          Saved. New runs use it immediately — no restart needed.
        </p>
      )}
      {def.hint ? (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{def.hint}</p>
      ) : null}
    </div>
  );
}
