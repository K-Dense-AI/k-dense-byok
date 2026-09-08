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

/**
 * `GET /providers/models`: every direct (API-key / cloud-credential) Pi
 * provider with whether a credential resolved, plus picker-shaped rows for the
 * configured ones. Entries arrive pre-shaped from the backend (like the
 * subscription providers), so discovery only needs the envelope.
 */
interface DirectProvidersResponse {
  providers?: { id: string; configured: boolean }[];
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
let directDiscoveryCache:
  | { value: DirectProvidersResponse; loadedAt: number }
  | undefined;
let directDiscoveryInFlight: Promise<DirectProvidersResponse> | undefined;

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
    const providers = Array.isArray(providerData?.providers)
      ? providerData.providers
      : [];
    // OpenRouter is usable with a pasted key OR a Pi OAuth sign-in.
    const openrouterOAuth = providers.some(
      (provider) => provider.id === "openrouter" && provider.connected,
    );
    const value: ProviderDiscovery = {
      providers,
      models: Array.isArray(modelData?.models) ? modelData.models : [],
      openrouterConfigured: credentialData?.openrouter
        ? Boolean(credentialData.openrouter.set) || openrouterOAuth
        : openrouterOAuth || null,
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

/** Direct API-key providers (NVIDIA NIM, Anthropic, OpenAI, Groq, …) in one call. */
function discoverDirectProviders(force = false): Promise<DirectProvidersResponse> {
  if (
    !force &&
    directDiscoveryCache &&
    Date.now() - directDiscoveryCache.loadedAt < DISCOVERY_CACHE_MS
  ) {
    return Promise.resolve(directDiscoveryCache.value);
  }
  if (directDiscoveryInFlight) return directDiscoveryInFlight;
  const request = apiFetch("/providers/models").then(async (response) =>
    response.ok
      ? ((await response.json()) as DirectProvidersResponse)
      : { providers: [], models: [] },
  );
  const inFlight = request
    .then((value) => {
      directDiscoveryCache = { value, loadedAt: Date.now() };
      return value;
    })
    .finally(() => {
      if (directDiscoveryInFlight === inFlight) directDiscoveryInFlight = undefined;
    });
  directDiscoveryInFlight = inFlight;
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
  /** Models from direct API-key providers (NVIDIA NIM, Anthropic, Groq, …), backend order. */
  directProviderModels: Model[];
  /** Ids of direct API-key providers for which the backend resolved a credential. */
  configuredDirectProviders: string[];
  modelAvailability: (model: Pick<Model, "id">) => ModelAvailability;
  /** Whether a current or persisted model can accept a new request. */
  isModelAvailable: (model: Pick<Model, "id">) => boolean;
  /** Re-fetch local and authenticated-provider models. */
  refresh: () => void;
}

/**
 * Merge the static OpenRouter catalogue with connected Pi OAuth providers,
 * key-configured direct providers, local Ollama tags, and user Fusion presets.
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
  const [directModels, setDirectModels] = useState<Model[]>([]);
  const [directProviders, setDirectProviders] = useState<
    { id: string; configured: boolean }[]
  >([]);
  const [directLoaded, setDirectLoaded] = useState(false);
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

  const fetchDirect = useCallback((force = false) => {
    void discoverDirectProviders(force)
      .then((data) => {
        setDirectProviders(Array.isArray(data.providers) ? data.providers : []);
        setDirectModels(Array.isArray(data.models) ? data.models : []);
        setDirectLoaded(true);
      })
      .catch(() => {
        setDirectProviders([]);
        setDirectModels([]);
        setDirectLoaded(true);
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
    fetchDirect();
    fetchProviders();
  }, [fetchOllama, fetchOpenAICompatible, fetchDirect, fetchProviders]);

  useEffect(
    () =>
      onProjectChange(() => {
        fetchOllama(true);
        fetchOpenAICompatible(true);
        fetchDirect(true);
        fetchProviders();
      }),
    [fetchOllama, fetchOpenAICompatible, fetchDirect, fetchProviders],
  );

  useEffect(() => {
    // Also re-probes the direct providers: Settings fires this event when a
    // key changes as well as after an OAuth login/logout.
    const refreshProviders = () => {
      fetchProviders(true);
      fetchDirect(true);
    };
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
    return () =>
      window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, refreshProviders);
  }, [fetchProviders, fetchDirect]);

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
      ...directModels,
      ...enrichedOllamaModels,
      ...enrichedOpenAICompatibleModels,
    ],
    [
      enrichedOllamaModels,
      enrichedOpenAICompatibleModels,
      fusionModels,
      directModels,
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
  const oauthProviderIds = useMemo(
    () => new Set(providerStatuses.map((provider) => provider.id)),
    [providerStatuses],
  );
  const directProviderIds = useMemo(
    () => new Set(directProviders.map((provider) => provider.id)),
    [directProviders],
  );
  const configuredDirectProviders = useMemo(
    () =>
      directProviders
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    [directProviders],
  );
  const configuredDirectSet = useMemo(
    () => new Set(configuredDirectProviders),
    [configuredDirectProviders],
  );

  const modelAvailability = useCallback(
    (model: Pick<Model, "id">): ModelAvailability => {
      const isOllama = model.id.startsWith("ollama/");
      const isOaiCompat = model.id.startsWith("openai-compatible/");
      const isRouter =
        model.id.startsWith("openrouter/") || model.id.startsWith("fusion/");
      if (isOllama && !ollamaLoaded) return "checking";
      if (isOaiCompat && !oaiCompatLoaded) return "checking";
      if (isRouter && openrouterConfigured === null) return "checking";
      // Every other prefix is a direct Pi provider (OAuth or API key); both
      // status lists must land before we can call it disconnected.
      if (!isOllama && !isOaiCompat && !isRouter) {
        if (!providerStatusLoaded || !directLoaded) return "checking";
      }

      const current = models.find((candidate) => candidate.id === model.id);
      if (current) return current.available === false ? "unavailable" : "available";
      if (isOllama) return "unavailable";
      // A persisted selection whose server stopped, or whose model was unloaded.
      if (isOaiCompat) return "unavailable";
      if (isRouter) {
        return openrouterConfigured === false ? "unavailable" : "available";
      }
      const providerId = model.id.split("/", 1)[0];
      // A persisted model absent from the provider's listed catalogue (e.g. a
      // NIM id the backend synthesizes, or a model newer than Pi's snapshot)
      // still reaches the backend, which is the final guard and answers with a
      // clear error — so only a missing credential makes it unavailable.
      if (configuredDirectSet.has(providerId) || connectedProviders.has(providerId)) {
        return "available";
      }
      if (directProviderIds.has(providerId) || oauthProviderIds.has(providerId)) {
        return "unavailable";
      }
      // Unknown prefix: a legacy bare OpenRouter vendor ref. Let the backend decide.
      return "available";
    },
    [
      configuredDirectSet,
      connectedProviders,
      directLoaded,
      directProviderIds,
      models,
      oaiCompatLoaded,
      oauthProviderIds,
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
    fetchDirect(true);
    fetchProviders(true);
  }, [fetchOllama, fetchOpenAICompatible, fetchDirect, fetchProviders]);

  return {
    models,
    ollamaModels: enrichedOllamaModels,
    ollamaAvailable,
    openaiCompatibleModels: enrichedOpenAICompatibleModels,
    openaiCompatibleAvailable: oaiCompatAvailable,
    openaiCompatibleConfigured: oaiCompatConfigured,
    providerModels,
    providerStatuses,
    directProviderModels: directModels,
    configuredDirectProviders,
    modelAvailability,
    isModelAvailable,
    refresh,
  };
}
