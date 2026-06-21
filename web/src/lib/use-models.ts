"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import staticModels from "@/data/models.json";
import type { Model } from "@/components/model-selector";
import { apiFetch, onProjectChange } from "@/lib/projects";

const OPENROUTER_MODELS = staticModels as Model[];

interface OllamaListResponse {
  available?: boolean;
  models?: Model[];
}

export interface UseModelsReturn {
  /** Every model available to the user: static OpenRouter catalogue + live Ollama tags + user Fusion configs. */
  models: Model[];
  /** Just the Ollama-sourced entries, in the order returned by the backend. */
  ollamaModels: Model[];
  /** True when the backend was able to reach `OLLAMA_BASE_URL/api/tags`. */
  ollamaAvailable: boolean;
  /** Re-fetch the Ollama list. */
  refresh: () => void;
}

export interface FusionConfig {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

/**
 * Merge the static OpenRouter-derived `models.json` with whatever models
 * are currently pulled in the user's local Ollama server.
 *
 * Ollama discovery is best-effort: if the daemon is offline we silently
 * fall back to OpenRouter-only. The hook re-fetches on project change to
 * keep the list fresh when the user returns after pulling a new model.
 */
export function useModels(): UseModelsReturn {
  const [ollamaModels, setOllamaModels] = useState<Model[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);

  const fetchOllama = useCallback(() => {
    apiFetch("/ollama/models")
      .then((r) => (r.ok ? (r.json() as Promise<OllamaListResponse>) : null))
      .then((data) => {
        if (!data) return;
        setOllamaAvailable(Boolean(data.available));
        setOllamaModels(Array.isArray(data.models) ? data.models : []);
      })
      .catch(() => {
        setOllamaAvailable(false);
        setOllamaModels([]);
      });
  }, []);

  useEffect(() => {
    fetchOllama();
  }, [fetchOllama]);

  useEffect(() => onProjectChange(() => fetchOllama()), [fetchOllama]);

  // Load user-defined Fusion configs (stored in localStorage by Settings)
  const fusionModels = useMemo(() => {
    try {
      const raw = localStorage.getItem("fusionConfigs");
      if (!raw) return [];
      const configs: FusionConfig[] = JSON.parse(raw);
      return configs.map((fc) => {
        const experts = (fc.config.experts as string[]) || [];
        const reasoning = (fc.config.reasoning_effort as string) || "standard";
        const expertNames = experts.length > 0 ? experts.join(", ") : "custom experts";
        const providers = experts.length > 0 ? [...new Set(experts.map((e: string) => e.split("/")[0]))].join("+") : "";

        // Calculate combined pricing from expert models (robust matching)
        let totalPrompt = 0;
        let totalCompletion = 0;

        for (const expertId of experts) {
          const cleanId = expertId.replace(/^openrouter\//, "");
          const expertModel = OPENROUTER_MODELS.find(m => 
            m.id === expertId || 
            m.id === `openrouter/${cleanId}` || 
            m.id.endsWith(`/${cleanId}`)
          );
          if (expertModel) {
            totalPrompt += expertModel.pricing.prompt;
            totalCompletion += expertModel.pricing.completion;
          }
        }

        return {
          id: `fusion/${fc.id}`,
          label: `${fc.name} ${providers}`,
          provider: "OR Fusion",
          tier: "flagship" as const,
          context_length: 1_000_000,
          pricing: { prompt: totalPrompt, completion: totalCompletion },
          modality: "text->text",
          description: `OpenRouter Fusion • ${expertNames} • ${reasoning} reasoning\n$${totalPrompt.toFixed(2)} in / $${totalCompletion.toFixed(2)} out per 1M tok`,
          isFusion: true,
          fusionConfig: fc.config,
        };
      }) as Model[];
    } catch {
      return [];
    }
  }, []);

  return {
    models: [...fusionModels, ...OPENROUTER_MODELS, ...ollamaModels],
    ollamaModels,
    ollamaAvailable,
    refresh: fetchOllama,
  };
}
