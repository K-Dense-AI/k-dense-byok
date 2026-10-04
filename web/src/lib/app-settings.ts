"use client";

/**
 * App-wide defaults for new chats (Settings → Models → Defaults), stored by
 * the backend in `<agentDir>/kady-settings.json` so every browser and the
 * server's own fallback runs agree. New tabs still copy the tab they were
 * opened from; these seed a project's first tab.
 */

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/projects";
import type { ThinkingLevel } from "@/components/thinking-selector";
import type { ModalInstance } from "@/lib/modal-jobs";

export interface ComputeDefault {
  target: string;
  gpuCount?: number;
  gpuFallback?: string[];
  cache?: "project" | "none";
}

export interface AppDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  compute?: ComputeDefault;
  /** The model `generate_image` uses unless the user asks for another. */
  imageModel?: string;
  /** The model verifier specialists run on (reviewers check with a different model). */
  verifierModel?: string;
}

/** An image model Kady can meter (GET /settings/image-models). */
export interface ImageModelOption {
  ref: string;
  name: string;
  /** Its provider is connected now. */
  available: boolean;
  /** Accepts reference images for edits. */
  imageInput: boolean;
  /** USD per million tokens. */
  cost: { input: number; output: number };
}

export interface ImageModelListing {
  models: ImageModelOption[];
  /** Built-in fallback order used when no default is saved. */
  builtIn: string[];
}

/** `null` clears a key; absent keys are left alone. */
export type AppDefaultsPatch = {
  [K in keyof AppDefaults]?: AppDefaults[K] | null;
};

const CHANGED_EVENT = "kady:app-defaults-changed";

let cache: AppDefaults | null = null;
let inFlight: Promise<AppDefaults> | null = null;
let verifierAgentsCache: string[] = [];

async function detailOf(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return new Error(typeof body?.detail === "string" ? body.detail : `${fallback} (${response.status})`);
}

export function getAppDefaults(force = false): Promise<AppDefaults> {
  if (cache && !force) return Promise.resolve(cache);
  if (inFlight && !force) return inFlight;
  const request = apiFetch("/settings/defaults")
    .then(async (response) => {
      if (!response.ok) throw await detailOf(response, "Failed to load defaults");
      const body = (await response.json()) as { defaults?: AppDefaults; verifierAgents?: string[] };
      cache = body.defaults ?? {};
      if (Array.isArray(body.verifierAgents)) verifierAgentsCache = body.verifierAgents;
      return cache;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

export async function putAppDefaults(patch: AppDefaultsPatch): Promise<AppDefaults> {
  const response = await apiFetch("/settings/defaults", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await detailOf(response, "Failed to save defaults");
  const body = (await response.json()) as { defaults?: AppDefaults; verifierAgents?: string[] };
  cache = body.defaults ?? {};
  if (Array.isArray(body.verifierAgents)) verifierAgentsCache = body.verifierAgents;
  window.dispatchEvent(new Event(CHANGED_EVENT));
  return cache;
}

/**
 * The specialists the verifier model applies to, as the backend last reported
 * them with the defaults (empty until `getAppDefaults` has loaded).
 */
export function getVerifierAgents(): string[] {
  return verifierAgentsCache;
}

export async function getImageModels(): Promise<ImageModelListing> {
  const response = await apiFetch("/settings/image-models");
  if (!response.ok) throw await detailOf(response, "Failed to load image models");
  const body = (await response.json()) as Partial<ImageModelListing>;
  return { models: body.models ?? [], builtIn: body.builtIn ?? [] };
}

/**
 * The saved defaults, or `null` until they load (or if the backend is older
 * than this setting). Callers fall back to the built-in defaults on null.
 */
export function useAppDefaults(): AppDefaults | null {
  const [defaults, setDefaults] = useState<AppDefaults | null>(cache);
  useEffect(() => {
    let cancelled = false;
    const load = (force: boolean) =>
      getAppDefaults(force)
        .then((value) => {
          if (!cancelled) setDefaults(value);
        })
        .catch(() => {
          if (!cancelled) setDefaults((current) => current ?? {});
        });
    void load(false);
    const onChanged = () => void load(false);
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGED_EVENT, onChanged);
    };
  }, []);
  return defaults;
}

export function computeDefaultFromInstance(instance: ModalInstance | null): ComputeDefault | null {
  if (!instance || instance.id === "local") return null;
  return {
    target: instance.id,
    ...(instance.gpuCount > 1 ? { gpuCount: instance.gpuCount } : {}),
    ...(instance.fallback ? { gpuFallback: [instance.fallback] } : {}),
    ...(instance.cache === "none" ? { cache: "none" as const } : {}),
  };
}

/**
 * Rebuild a selectable instance from a saved default: the catalogue entry
 * when known (so labels and prices render), else a minimal placeholder the
 * compute chip marks as legacy.
 */
export function computeInstanceFromDefault(
  value: ComputeDefault | undefined,
  instances: readonly ModalInstance[] | undefined,
): ModalInstance | null {
  if (!value || value.target === "local") return null;
  const known = instances?.find((instance) => instance.id === value.target);
  const base: ModalInstance = known ?? {
    id: value.target,
    label: value.target,
    gpu: null,
    gpuCount: 1,
    cpu: null,
    memoryMiB: null,
    pricePerHour: 0,
  };
  return {
    ...base,
    gpuCount: value.gpuCount ?? base.gpuCount,
    fallback: value.gpuFallback?.[0] ?? null,
    cache: value.cache ?? "project",
  };
}

/** Test hook: forget the module cache between tests. */
export function resetAppDefaultsCache(): void {
  cache = null;
  inFlight = null;
  verifierAgentsCache = [];
}
