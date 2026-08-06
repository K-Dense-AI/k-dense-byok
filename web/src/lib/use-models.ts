"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import staticModels from "@/data/models.json";
import type { Model } from "@/components/model-selector";
import { apiFetch, onProjectChange } from "@/lib/projects";
import {
  JUDGE_CALLS_PER_TURN,
  fusionJudgeModel,
  fusionPanelModels,
  loadFusionConfigs,
} from "@/lib/fusion-presets";
import {
  PROVIDER_AUTH_CHANGED_EVENT,
  type ModelProviderStatus,
} from "@/lib/use-provider-auth";

const OPENROUTER_MODELS = staticModels as Model[];

interface OllamaListResponse {
  available?: boolean;
  models?: Model[];
}

interface OpenAICompatibleListResponse {
  available?: boolean;
  /** True when OPENAI_COMPATIBLE_BASE_URL was set explicitly. */
  configured?: boolean;
  models?: Model[];
}

interface NvidiaListResponse {
  /** True when an NVIDIA API key resolved on the backend. */
  configured?: boolean;
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
let oaiCompatDiscoveryCache:
  | { value: OpenAICompatibleListResponse; loadedAt: number }
  | undefined;
let oaiCompatDiscoveryInFlight:
  | Promise<OpenAICompatibleListResponse>
  | undefined;
let nvidiaDiscoveryCache:
  | { value: NvidiaListResponse; loadedAt: number }
  | undefined;
let nvidiaDiscoveryInFlight: Promise<NvidiaListResponse> | undefined;

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

/** Parallel to discoverOllama; a separate endpoint speaking a separate protocol. */
function discoverOpenAICompatible(
  force = false,
): Promise<OpenAICompatibleListResponse> {
  if (
    !force &&
    oaiCompatDiscoveryCache &&
    Date.now() - oaiCompatDiscoveryCache.loadedAt < DISCOVERY_CACHE_MS
  ) {
    return Promise.resolve(oaiCompatDiscoveryCache.value);
  }
  if (oaiCompatDiscoveryInFlight) return oaiCompatDiscoveryInFlight;
  const request = apiFetch("/openai-compatible/models").then(async (response) =>
    response.ok
      ? ((await response.json()) as OpenAICompatibleListResponse)
      : { available: false, configured: false, models: [] },
  );
  const inFlight = request
    .then((value) => {
      oaiCompatDiscoveryCache = { value, loadedAt: Date.now() };
      return value;
    })
    .finally(() => {
      if (oaiCompatDiscoveryInFlight === inFlight) {
        oaiCompatDiscoveryInFlight = undefined;
      }
    });
  oaiCompatDiscoveryInFlight = inFlight;
  return inFlight;
}

/** NVIDIA NIM models come pre-shaped from the backend (like the subscription
 *  providers), so discovery only needs the `{configured, models}` envelope. */
function discoverNvidia(force = false): Promise<NvidiaListResponse> {
  if (
    !force &&
    nvidiaDiscoveryCache &&
    Date.now() - nvidiaDiscoveryCache.loadedAt < DISCOVERY_CACHE_MS
  ) {
    return Promise.resolve(nvidiaDiscoveryCache.value);
  }
  if (nvidiaDiscoveryInFlight) return nvidiaDiscoveryInFlight;
  const request = apiFetch("/nvidia/models").then(async (response) =>
    response.ok
      ? ((await response.json()) as NvidiaListResponse)
      : { configured: false, models: [] },
  );
  const inFlight = request
    .then((value) => {
      nvidiaDiscoveryCache = { value, loadedAt: Date.now() };
      return value;
    })
    .finally(() => {
      if (nvidiaDiscoveryInFlight === inFlight) nvidiaDiscoveryInFlight = undefined;
    });
  nvidiaDiscoveryInFlight = inFlight;
  return inFlight;
}

export interface UseModelsReturn {
  /** Every model available to the user: static OpenRouter catalogue + live Ollama tags + user Fusion configs. */
  models: Model[];
  /** Just the Ollama-sourced entries, in the order returned by the backend. */
  ollamaModels: Model[];
  /** True when the backend was able to reach `OLLAMA_BASE_URL/api/tags`. */
  ollamaAvailable: boolean;
  /** Entries from a local OpenAI-compatible server, backend order. */
  openaiCompatibleModels: Model[];
  /** True when the backend reached `OPENAI_COMPATIBLE_BASE_URL/v1/models`. */
  openaiCompatibleAvailable: boolean;
  /**
   * True when the user set OPENAI_COMPATIBLE_BASE_URL. The picker shows the
   * section when this or `openaiCompatibleAvailable` holds, so users who never
   * run one of these servers never see it.
   */
  openaiCompatibleConfigured: boolean;
  /** Direct Pi-provider models available through connected subscriptions. */
  providerModels: Model[];
  providerStatuses: ModelProviderStatus[];
  /** NVIDIA NIM models, present once an NVIDIA API key is configured. */
  nvidiaModels: Model[];
  /** True when the backend resolved an NVIDIA API key. */
  nvidiaConfigured: boolean;
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
  const [oaiCompatModels, setOaiCompatModels] = useState<Model[]>([]);
  const [oaiCompatAvailable, setOaiCompatAvailable] = useState(false);
  const [oaiCompatConfigured, setOaiCompatConfigured] = useState(false);
  const [oaiCompatLoaded, setOaiCompatLoaded] = useState(false);
  const [providerModels, setProviderModels] = useState<Model[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<ModelProviderStatus[]>([]);
  const [providerStatusLoaded, setProviderStatusLoaded] = useState(false);
  const [nvidiaModels, setNvidiaModels] = useState<Model[]>([]);
  const [nvidiaConfigured, setNvidiaConfigured] = useState(false);
  const [nvidiaLoaded, setNvidiaLoaded] = useState(false);
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

  const fetchOpenAICompatible = useCallback((force = false) => {
    void discoverOpenAICompatible(force)
      .then((data) => {
        setOaiCompatAvailable(Boolean(data.available));
        setOaiCompatConfigured(Boolean(data.configured));
        setOaiCompatModels(Array.isArray(data.models) ? data.models : []);
        setOaiCompatLoaded(true);
      })
      .catch(() => {
        setOaiCompatAvailable(false);
        setOaiCompatModels([]);
        setOaiCompatLoaded(true);
      });
  }, []);

  const fetchNvidia = useCallback((force = false) => {
    void discoverNvidia(force)
      .then((data) => {
        setNvidiaConfigured(Boolean(data.configured));
        setNvidiaModels(Array.isArray(data.models) ? data.models : []);
        setNvidiaLoaded(true);
      })
      .catch(() => {
        setNvidiaConfigured(false);
        setNvidiaModels([]);
        setNvidiaLoaded(true);
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
    fetchOpenAICompatible();
    fetchNvidia();
    fetchProviders();
  }, [fetchOllama, fetchOpenAICompatible, fetchNvidia, fetchProviders]);

  useEffect(
    () =>
      onProjectChange(() => {
        fetchOllama(true);
        fetchOpenAICompatible(true);
        fetchNvidia(true);
        fetchProviders();
      }),
    [fetchOllama, fetchOpenAICompatible, fetchNvidia, fetchProviders],
  );

  useEffect(() => {
    // Also re-probes NVIDIA: Settings fires this event when the key changes.
    const refreshProviders = () => {
      fetchProviders(true);
      fetchNvidia(true);
    };
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
    return () =>
      window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
  }, [fetchProviders, fetchNvidia]);

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
      const judgeId = fusionJudgeModel(cfg);
      const reasoning = (cfg.reasoning_effort as string) || "standard";

      // Combined price = each panel model once + the judge JUDGE_CALLS_PER_TURN
      // times. Must match buildFusionModel() on the server, which is what
      // actually gets ledgered — the two are separate copies of this formula.
      let totalPrompt = 0;
      let totalCompletion = 0;
      const missing: string[] = [];
      const priceOf = (modelId: string) => {
        const cleanId = modelId.replace(/^openrouter\//, "");
        const found = OPENROUTER_MODELS.find(
          (m) => m.id === `openrouter/${cleanId}` || m.id === modelId,
        );
        if (!found) missing.push(cleanId);
        return found?.pricing;
      };
      for (const modelId of panel) {
        const pricing = priceOf(modelId);
        if (!pricing) continue;
        totalPrompt += pricing.prompt;
        totalCompletion += pricing.completion;
      }
      if (judgeId) {
        const pricing = priceOf(judgeId);
        if (pricing) {
          totalPrompt += JUDGE_CALLS_PER_TURN * pricing.prompt;
          totalCompletion += JUDGE_CALLS_PER_TURN * pricing.completion;
        }
      }

      const panelNames = panel.length > 0 ? panel.join(", ") : "custom panel";
      const judgeLine = judgeId ? ` • judge ${judgeId} (×${JUDGE_CALLS_PER_TURN})` : "";
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
          `OpenRouter Fusion • ${panelNames}${judgeLine} • ${reasoning} reasoning` +
          `\n$${totalPrompt.toFixed(2)} in / $${totalCompletion.toFixed(2)} out per 1M tok` +
          ` (panel + ${JUDGE_CALLS_PER_TURN}× judge)` +
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

  const enrichedOpenAICompatibleModels = useMemo<Model[]>(
    () =>
      oaiCompatModels.map((model) => ({
        ...model,
        sourceId: "openai-compatible",
        sourceLabel: "Local (OpenAI-compatible)",
        billingMode: "local",
        reasoning: false,
        available: oaiCompatAvailable,
      })),
    [oaiCompatAvailable, oaiCompatModels],
  );

  const models = useMemo(
    () => [
      ...fusionModels,
      ...providerModels,
      ...openrouterModels,
      ...nvidiaModels,
      ...enrichedOllamaModels,
      ...enrichedOpenAICompatibleModels,
    ],
    [
      enrichedOllamaModels,
      enrichedOpenAICompatibleModels,
      fusionModels,
      nvidiaModels,
      openrouterModels,
      providerModels,
    ],
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
      if (model.id.startsWith("openai-compatible/") && !oaiCompatLoaded) {
        return "checking";
      }
      if (model.id.startsWith("nvidia/") && !nvidiaLoaded) return "checking";
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
      // A persisted selection whose server stopped, or whose model was unloaded.
      if (model.id.startsWith("openai-compatible/")) return "unavailable";
      // A persisted NIM model absent from Pi's catalogue still runs (the
      // backend synthesizes it), so only a missing key makes it unavailable.
      if (model.id.startsWith("nvidia/")) {
        return nvidiaConfigured ? "available" : "unavailable";
      }
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
      nvidiaConfigured,
      nvidiaLoaded,
      oaiCompatLoaded,
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
    fetchOpenAICompatible(true);
    fetchNvidia(true);
    fetchProviders(true);
  }, [fetchOllama, fetchOpenAICompatible, fetchNvidia, fetchProviders]);

  return {
    models,
    ollamaModels: enrichedOllamaModels,
    ollamaAvailable,
    openaiCompatibleModels: enrichedOpenAICompatibleModels,
    openaiCompatibleAvailable: oaiCompatAvailable,
    openaiCompatibleConfigured: oaiCompatConfigured,
    providerModels,
    providerStatuses,
    nvidiaModels,
    nvidiaConfigured,
    modelAvailability,
    isModelAvailable,
    refresh,
  };
}
