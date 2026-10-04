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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  computeDefaultFromInstance,
  computeInstanceFromDefault,
  getAppDefaults,
  getImageModels,
  getVerifierAgents,
  putAppDefaults,
  type AppDefaults,
  type ImageModelListing,
} from "@/lib/app-settings";
import type { ModalInstance } from "@/lib/modal-jobs";
import { useModalCatalog } from "@/lib/use-modal-jobs";
import { useModels } from "@/lib/use-models";
import { ModelField } from "./model-field";
import { SettingsCard, SettingsError, SettingsHeader, SettingsNotice } from "./primitives";

interface Draft {
  model: string;
  thinkingLevel: ThinkingLevel;
  compute: ModalInstance | null;
  /** "" = not set (built-in order). */
  imageModel: string;
  /** "" = not set (verifiers use their usual model). */
  verifierModel: string;
}

/** Select value for "not set"; Radix forbids an empty-string item value. */
const BUILT_IN_IMAGE_MODEL = "__built-in__";

function draftFrom(defaults: AppDefaults, instances: readonly ModalInstance[] | undefined): Draft {
  return {
    model: defaults.model ?? "",
    thinkingLevel: defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    compute: computeInstanceFromDefault(defaults.compute, instances),
    imageModel: defaults.imageModel ?? "",
    verifierModel: defaults.verifierModel ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.model === b.model &&
    a.thinkingLevel === b.thinkingLevel &&
    a.imageModel === b.imageModel &&
    a.verifierModel === b.verifierModel &&
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
  const [imageModels, setImageModels] = useState<ImageModelListing | null>(null);
  const [imageModelsError, setImageModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageModels()
      .then((listing) => {
        if (!cancelled) setImageModels(listing);
      })
      .catch((cause) => {
        if (!cancelled) setImageModelsError(cause instanceof Error ? cause.message : "Failed to load image models");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        imageModel: draft.imageModel || null,
        verifierModel: draft.verifierModel || null,
      });
      setSaved(next);
      setDraft(draftFrom(next, instances));
      setNotice("Saved. A project's next first chat starts with these; the image and verifier models apply right away.");
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
        </SettingsCard>
      )}

      {draft && (
        <SettingsCard title="Image generation">
          <ImageModelField
            value={draft.imageModel}
            listing={imageModels}
            error={imageModelsError}
            onChange={(imageModel) => setDraft({ ...draft, imageModel })}
          />
        </SettingsCard>
      )}

      {draft && (
        <SettingsCard title="Verification">
          <VerifierModelField
            value={draft.verifierModel}
            onChange={(verifierModel) => setDraft({ ...draft, verifierModel })}
          />
        </SettingsCard>
      )}

      {draft && (
        <div className="flex justify-end gap-2">
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
      )}
    </div>
  );
}

/** The model verifier specialists run on, so checks come from a different model. */
function VerifierModelField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { modelAvailability } = useModels();
  const agents = getVerifierAgents();
  const disconnected = Boolean(value) && modelAvailability({ id: value }) === "unavailable";
  return (
    <div className="grid gap-1.5">
      <label htmlFor="default-verifier-model" className="text-xs font-medium">
        Verifier model
      </label>
      <ModelField
        id="default-verifier-model"
        label="Verifier model"
        value={value}
        emptyLabel="Not set — verifiers run on the same model as other specialists"
        onChange={onChange}
      />
      {disconnected ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This model&apos;s provider is not connected, so verifiers keep their usual model until you connect it under{" "}
          <SettingsLink tab="providers">Providers</SettingsLink>.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Specialists that check work run on this model, so a result is reviewed by a different model than the one
          that produced it. A specialist that pins its own model keeps it. Applies to the next delegation, including in
          open chats; verifier runs count toward the project spend cap like any other.
        </p>
      )}
      {agents.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Applies to: <span className="font-mono">{agents.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

const price = (perMillion: number) => `$${Number.isInteger(perMillion) ? perMillion : perMillion.toFixed(2)}`;

/** Image model for `generate_image`: only models Kady can meter are listed. */
function ImageModelField({
  value,
  listing,
  error,
  onChange,
}: {
  value: string;
  listing: ImageModelListing | null;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const models = listing?.models ?? [];
  const byRef = new Map(models.map((model) => [model.ref, model] as const));
  const builtIn = listing?.builtIn.map((ref) => byRef.get(ref)?.name ?? ref) ?? [];
  const selected = value ? byRef.get(value) : undefined;
  const connected = models.filter((model) => model.available);
  const disconnected = models.filter((model) => !model.available);
  const row = (model: (typeof models)[number]) => (
    <SelectItem key={model.ref} value={model.ref} className="text-xs" disabled={!model.available}>
      <div className="flex flex-col">
        <span>{model.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {price(model.cost.input)} in · {price(model.cost.output)} out per M tokens
          {model.imageInput ? " · edits images" : ""}
        </span>
      </div>
    </SelectItem>
  );
  return (
    <div className="grid gap-1.5">
      <label htmlFor="default-image-model" className="text-xs font-medium">
        Image model
      </label>
      <Select
        value={value || BUILT_IN_IMAGE_MODEL}
        onValueChange={(next) => onChange(next === BUILT_IN_IMAGE_MODEL ? "" : next)}
        disabled={!listing}
      >
        <SelectTrigger id="default-image-model" size="sm" className="h-8 w-full text-xs" aria-label="Default image model">
          {/* Explicit children: the items carry a price line the trigger must not mirror. */}
          <SelectValue>
            {value ? (selected?.name ?? value) : `Not set — Kady's default (${builtIn[0] ?? "built-in order"})`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={BUILT_IN_IMAGE_MODEL} className="text-xs">
              Not set — Kady&apos;s default{builtIn.length ? ` (${builtIn.join(", then ")})` : ""}
            </SelectItem>
          </SelectGroup>
          {connected.length > 0 && (
            <SelectGroup>
              <SelectLabel className="text-[10px]">Connected</SelectLabel>
              {connected.map(row)}
            </SelectGroup>
          )}
          {disconnected.length > 0 && (
            <SelectGroup>
              <SelectLabel className="text-[10px]">Not connected</SelectLabel>
              {disconnected.map(row)}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : value && selected && !selected.available ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This model&apos;s provider is not connected, so Kady uses its built-in default until you connect it under{" "}
          <SettingsLink tab="providers">Providers</SettingsLink>.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Used when Kady generates figures and schematics, unless you ask for another model in chat. Only models priced
          per token are listed, so every image counts toward the project spend cap. Applies right away, including to
          open chats.
        </p>
      )}
    </div>
  );
}
