"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComputeSelector } from "@/components/compute-selector";
import { DEFAULT_MODEL } from "@/components/model-selector";
import { SettingsLink } from "@/components/settings-link";
import {
  DEFAULT_THINKING_LEVEL,
  ThinkingSelector,
  type ThinkingLevel,
} from "@/components/thinking-selector";
import {
  computeDefaultFromInstance,
  computeInstanceFromDefault,
  getAppDefaults,
  putAppDefaults,
  type AppDefaults,
} from "@/lib/app-settings";
import type { ModalInstance } from "@/lib/modal-jobs";
import { useModalCatalog } from "@/lib/use-modal-jobs";
import { ModelField } from "./model-field";
import { SettingsCard, SettingsError, SettingsHeader, SettingsNotice } from "./primitives";

interface Draft {
  model: string;
  thinkingLevel: ThinkingLevel;
  compute: ModalInstance | null;
}

function draftFrom(defaults: AppDefaults, instances: readonly ModalInstance[] | undefined): Draft {
  return {
    model: defaults.model ?? "",
    thinkingLevel: defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    compute: computeInstanceFromDefault(defaults.compute, instances),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.model === b.model &&
    a.thinkingLevel === b.thinkingLevel &&
    JSON.stringify(computeDefaultFromInstance(a.compute)) ===
      JSON.stringify(computeDefaultFromInstance(b.compute))
  );
}

export function DefaultsPanel() {
  const modal = useModalCatalog();
  const [saved, setSaved] = useState<AppDefaults | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAppDefaults(true)
      .then((value) => {
        if (cancelled) return;
        setSaved(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load defaults");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rebuild once the Modal catalogue lands so a saved target shows its label.
  const instances = modal.catalog?.instances;
  const baseline = useMemo(() => (saved ? draftFrom(saved, instances) : null), [saved, instances]);
  useEffect(() => {
    if (baseline) setDraft((current) => current ?? baseline);
  }, [baseline]);

  const dirty = Boolean(draft && baseline && !sameDraft(draft, baseline));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await putAppDefaults({
        model: draft.model || null,
        thinkingLevel: draft.thinkingLevel === DEFAULT_THINKING_LEVEL ? null : draft.thinkingLevel,
        compute: computeDefaultFromInstance(draft.compute),
      });
      setSaved(next);
      setDraft(draftFrom(next, instances));
      setNotice("Saved. A project's next first chat starts with these.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsHeader
        title="Defaults for new chats"
        description={
          <>
            What a project&apos;s first chat tab starts with. A new tab opened next to an existing
            one copies that tab&apos;s choices instead, and runs Kady starts on its own (schedules,
            system turns) reuse the project&apos;s latest chat model, falling back to this default.
            Specialists have their own default under{" "}
            <SettingsLink tab="specialists">Specialists</SettingsLink>.
          </>
        }
      />

      <SettingsError>{error}</SettingsError>
      <SettingsNotice>{notice}</SettingsNotice>

      {!draft ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading…
        </p>
      ) : (
        <SettingsCard title="New chat">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="default-model" className="text-xs font-medium">
                Model
              </label>
              <ModelField
                id="default-model"
                label="Default model"
                value={draft.model}
                emptyLabel={`Not set — Kady's default (${DEFAULT_MODEL.label} unless DEFAULT_MODEL_* is set in .env)`}
                onChange={(model) => setDraft({ ...draft, model })}
              />
              <p className="text-[11px] text-muted-foreground">
                Pick a model you have access to — a disconnected default makes every new project
                start on a model that cannot run.
              </p>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Thinking level</span>
              <div className="flex">
                <ThinkingSelector
                  selected={draft.thinkingLevel}
                  onChange={(thinkingLevel) => setDraft({ ...draft, thinkingLevel })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Compute</span>
              <div className="flex">
                <ComputeSelector
                  selected={draft.compute}
                  onChange={(compute) => setDraft({ ...draft, compute })}
                  catalog={modal.catalog}
                  loading={modal.loading}
                  error={modal.error}
                  onRefresh={modal.refresh}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Remote targets need Modal connected under{" "}
                <SettingsLink tab="services" section="modal">
                  Services
                </SettingsLink>
                ; runs fall back to the local sandbox otherwise.
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs"
              disabled={!dirty || saving}
              onClick={() => baseline && setDraft(baseline)}
            >
              Discard
            </Button>
            <Button type="button" size="sm" className="text-xs" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save defaults"}
            </Button>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
