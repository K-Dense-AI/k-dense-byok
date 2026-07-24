"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import staticModels from "@/data/models.json";
import type { Model } from "@/components/model-selector";
import { apiFetch, onProjectChange } from "@/lib/projects";
import { fusionPanelModels, loadFusionConfigs } from "@/lib/fusion-presets";
import {
  PROVIDER_AUTH_CHANGED_EVENT,
  type ModelProviderStatus,
} from "@/lib/use-provider-auth";

const OPENROUTER_MODELS = staticModels as Model[];

interface OllamaListResponse {
  available?: boolean;
  models?: Model[];
}

export type ModelAvailability = "checking" | "available" | "unavailable";

interface ProviderDiscovery {
  providers: ModelProviderStatus[];
  models: Model[];
  openrouterConfigured: boolean | null;
}

const DISCOVERY_CACHE_MS = 2_000;
let providerDiscoveryCache:
  | { value: ProviderDiscovery; loadedAt: number }
  | undefined;
let providerDiscoveryInFlight: Promise<ProviderDiscovery> | undefined;
let ollamaDiscoveryCache:
  | { value: OllamaListResponse; loadedAt: number }
  | undefined;
let ollamaDiscoveryInFlight: Promise<OllamaListResponse> | undefined;

function discoverProviders(force = false): Promise<ProviderDiscovery> {
  if (
    !force &&
    providerDiscoveryCache &&
    Date.now() - providerDiscoveryCache.loadedAt < DISCOVERY_CACHE_MS
  ) {
    return Promise.resolve(providerDiscoveryCache.value);
  }
  if (providerDiscoveryInFlight) return providerDiscoveryInFlight;
  const request = Promise.all([
    apiFetch("/model-providers"),
    apiFetch("/model-providers/models"),
    apiFetch("/credentials"),
  ]).then(async ([providersResponse, modelsResponse, credentialsResponse]) => {
    const providerData = providersResponse.ok
      ? ((await providersResponse.json()) as {
          providers?: ModelProviderStatus[];
        })
      : null;
    const modelData = modelsResponse.ok
      ? ((await modelsResponse.json()) as { models?: Model[] })
      : null;
    const credentialData = credentialsResponse.ok
      ? ((await credentialsResponse.json()) as {
          openrouter?: { set?: boolean };
        })
      : null;
    const value: ProviderDiscovery = {
      providers: Array.isArray(providerData?.providers)
        ? providerData.providers
        : [],
      models: Array.isArray(modelData?.models) ? modelData.models : [],
      openrouterConfigured: credentialData?.openrouter
        ? Boolean(credentialData.openrouter.set)
        : null,
    };
    providerDiscoveryCache = { value, loadedAt: Date.now() };
    return value;
  });
  const inFlight = request.finally(() => {
    if (providerDiscoveryInFlight === inFlight) providerDiscoveryInFlight = undefined;
  });
  providerDiscoveryInFlight = inFlight;
  return inFlight;
}

function discoverOllama(force = false): Promise<OllamaListResponse> {
  if (
    !force &&
    ollamaDiscoveryCache &&
    Date.now() - ollamaDiscoveryCache.loadedAt < DISCOVERY_CACHE_MS
  ) {
    return Promise.resolve(ollamaDiscoveryCache.value);
  }
  if (ollamaDiscoveryInFlight) return ollamaDiscoveryInFlight;
  const request = apiFetch("/ollama/models").then(async (response) =>
    response.ok
      ? ((await response.json()) as OllamaListResponse)
      : { available: false, models: [] },
  );
  const inFlight = request
    .then((value) => {
      ollamaDiscoveryCache = { value, loadedAt: Date.now() };
      return value;
    })
    .finally(() => {
      if (ollamaDiscoveryInFlight === inFlight) ollamaDiscoveryInFlight = undefined;
    });
  ollamaDiscoveryInFlight = inFlight;
  return inFlight;
}

export interface UseModelsReturn {
  /** Every model available to the user: static OpenRouter catalogue + live Ollama tags + user Fusion configs. */
  models: Model[];
  /** Just the Ollama-sourced entries, in the order returned by the backend. */
  ollamaModels: Model[];
  /** True when the backend was able to reach `OLLAMA_BASE_URL/api/tags`. */
  ollamaAvailable: boolean;
  /** Direct Pi-provider models available through connected subscriptions. */
  providerModels: Model[];
  providerStatuses: ModelProviderStatus[];
  modelAvailability: (model: Pick<Model, "id">) => ModelAvailability;
  /** Whether a current or persisted model can accept a new request. */
  isModelAvailable: (model: Pick<Model, "id">) => boolean;
  /** Re-fetch local and authenticated-provider models. */
  refresh: () => void;
}

/**
 * Merge the static OpenRouter catalogue with connected Pi OAuth providers,
 * local Ollama tags, and user Fusion presets.
 *
 * Discovery is best-effort: unavailable sources are marked disconnected while
 * other providers remain usable. The hook refreshes on project/auth changes.
 */
export function useModels(): UseModelsReturn {
  const [ollamaModels, setOllamaModels] = useState<Model[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);
  const [ollamaLoaded, setOllamaLoaded] = useState(false);
  const [providerModels, setProviderModels] = useState<Model[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<ModelProviderStatus[]>([]);
  const [providerStatusLoaded, setProviderStatusLoaded] = useState(false);
  const [openrouterConfigured, setOpenrouterConfigured] = useState<boolean | null>(
    null,
  );
  const providerRequestId = useRef(0);

  const fetchOllama = useCallback((force = false) => {
    void discoverOllama(force)
      .then((data) => {
        setOllamaAvailable(Boolean(data.available));
        setOllamaModels(Array.isArray(data.models) ? data.models : []);
        setOllamaLoaded(true);
      })
      .catch(() => {
        setOllamaAvailable(false);
        setOllamaModels([]);
        setOllamaLoaded(true);
      });
  }, []);

  const fetchProviders = useCallback((force = false) => {
    const requestId = ++providerRequestId.current;
    void discoverProviders(force)
      .then((data) => {
        if (requestId !== providerRequestId.current) return;
        setProviderStatuses(data.providers);
        setProviderStatusLoaded(true);
        setProviderModels(data.models);
        if (data.openrouterConfigured !== null) {
          setOpenrouterConfigured(data.openrouterConfigured);
        }
      })
      .catch(() => {
        // Keep the static catalogue usable while the local status endpoint is
        // temporarily unavailable; the backend remains the final auth guard.
      });
  }, []);

  useEffect(() => {
    fetchOllama();
    fetchProviders();
  }, [fetchOllama, fetchProviders]);

  useEffect(
    () =>
      onProjectChange(() => {
        fetchOllama(true);
        fetchProviders();
      }),
    [fetchOllama, fetchProviders],
  );

  useEffect(() => {
    const refreshProviders = () => fetchProviders(true);
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
    return () =>
      window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
  }, [fetchProviders]);

  // Re-read Fusion configs when Settings saves them (or another tab edits them).
  const [fusionRevision, setFusionRevision] = useState(0);
  useEffect(() => {
    const bump = () => setFusionRevision((v) => v + 1);
    window.addEventListener("fusion-configs-changed", bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener("fusion-configs-changed", bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  // Build synthetic "model" entries from the saved/default Fusion presets so they
  // appear at the top of the model selector with combined panel pricing.
  const fusionModels = useMemo<Model[]>(() => {
    void fusionRevision; // recompute when Settings saves/edits Fusion configs
    const out: Model[] = [];
    for (const fc of loadFusionConfigs()) {
      let cfg: Record<string, unknown>;
      try {
        cfg =
          typeof fc.config === "string"
            ? JSON.parse(fc.config)
            : (fc.config as Record<string, unknown>);
      } catch {
        continue; // skip one malformed preset rather than dropping them all
      }

      const panel = fusionPanelModels(cfg);
      const reasoning = (cfg.reasoning_effort as string) || "standard";

      // Combined input/output price = sum of the panel models' catalogue prices.
      let totalPrompt = 0;
      let totalCompletion = 0;
      const missing: string[] = [];
      for (const modelId of panel) {
        const cleanId = modelId.replace(/^openrouter\//, "");
        const found = OPENROUTER_MODELS.find(
          (m) => m.id === `openrouter/${cleanId}` || m.id === modelId,
        );
        if (found) {
          totalPrompt += found.pricing.prompt;
          totalCompletion += found.pricing.completion;
        } else {
          missing.push(cleanId);
        }
      }

      const panelNames = panel.length > 0 ? panel.join(", ") : "custom panel";
      const noteLine = fc.note ? `\n${fc.note}` : "";
      const missingLine = missing.length
        ? `\n⚠ no catalogue price for: ${missing.join(", ")}`
        : "";

      out.push({
        id: `fusion/${fc.id}`,
        label: fc.name,
        provider: "Openrouter Fusion",
        tier: "flagship",
        context_length: 1_000_000,
        pricing: { prompt: totalPrompt, completion: totalCompletion },
        modality: "text->text",
        description:
          `OpenRouter Fusion • ${panelNames} • ${reasoning} reasoning` +
          `\n$${totalPrompt.toFixed(2)} in / $${totalCompletion.toFixed(2)} out per 1M tok (combined)` +
          noteLine +
          missingLine,
        isFusion: true,
        fusionConfig: cfg,
        sourceId: "openrouter",
        sourceLabel: "OpenRouter Fusion",
        billingMode: "payg",
        reasoning: false,
        available: openrouterConfigured !== false,
      });
    }
    return out;
  }, [fusionRevision, openrouterConfigured]);

  const openrouterModels = useMemo<Model[]>(
    () =>
      OPENROUTER_MODELS.filter((model) => !model.isFusion).map((model) => ({
        ...model,
        sourceId: "openrouter",
        sourceLabel: "OpenRouter",
        billingMode: "payg",
        reasoning: true,
        available: openrouterConfigured !== false,
      })),
    [openrouterConfigured],
  );

  const enrichedOllamaModels = useMemo<Model[]>(
    () =>
      ollamaModels.map((model) => ({
        ...model,
        sourceId: "ollama",
        sourceLabel: "Local (Ollama)",
        billingMode: "local",
        reasoning: false,
        available: ollamaAvailable,
      })),
    [ollamaAvailable, ollamaModels],
  );

  const models = useMemo(
    () => [
      ...fusionModels,
      ...providerModels,
      ...openrouterModels,
      ...enrichedOllamaModels,
    ],
    [enrichedOllamaModels, fusionModels, openrouterModels, providerModels],
  );

  const connectedProviders = useMemo(
    () =>
      new Set(
        providerStatuses
          .filter((provider) => provider.connected)
          .map((provider) => provider.id),
      ),
    [providerStatuses],
  );

  const modelAvailability = useCallback(
    (model: Pick<Model, "id">): ModelAvailability => {
      if (model.id.startsWith("ollama/") && !ollamaLoaded) return "checking";
      if (
        (model.id.startsWith("openrouter/") || model.id.startsWith("fusion/")) &&
        openrouterConfigured === null
      ) {
        return "checking";
      }
      const providerId = model.id.split("/", 1)[0];
      const isDirectProvider =
        providerId === "openai-codex" ||
        providerId === "anthropic" ||
        providerId === "github-copilot" ||
        providerId === "xai";
      if (isDirectProvider && !providerStatusLoaded) return "checking";

      const current = models.find((candidate) => candidate.id === model.id);
      if (current) return current.available === false ? "unavailable" : "available";
      if (model.id.startsWith("ollama/")) return "unavailable";
      if (model.id.startsWith("openrouter/") || model.id.startsWith("fusion/")) {
        return openrouterConfigured === false ? "unavailable" : "available";
      }
      if (isDirectProvider) {
        return connectedProviders.has(providerId as ModelProviderStatus["id"])
          ? "available"
          : "unavailable";
      }
      return "available";
    },
    [
      connectedProviders,
      models,
      ollamaLoaded,
      openrouterConfigured,
      providerStatusLoaded,
    ],
  );

  const isModelAvailable = useCallback(
    (model: Pick<Model, "id">): boolean => {
      return modelAvailability(model) === "available";
    },
    [modelAvailability],
  );

  const refresh = useCallback(() => {
    fetchOllama(true);
    fetchProviders(true);
  }, [fetchOllama, fetchProviders]);

  return {
    models,
    ollamaModels: enrichedOllamaModels,
    ollamaAvailable,
    providerModels,
    providerStatuses,
    modelAvailability,
    isModelAvailable,
    refresh,
  };
}
