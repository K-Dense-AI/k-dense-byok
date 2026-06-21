"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import staticModels from "@/data/models.json";
import type { Model } from "@/components/model-selector";
import { apiFetch, onProjectChange } from "@/lib/projects";
import { fusionPanelModels, loadFusionConfigs } from "@/lib/fusion-presets";

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
      });
    }
    return out;
  }, [fusionRevision]);

  return {
    // Drop the static `openrouter/fusion` catalogue row — the presets above
    // replace it (it was a non-functional $0 duplicate).
    models: [...fusionModels, ...OPENROUTER_MODELS.filter((m) => !m.isFusion), ...ollamaModels],
    ollamaModels,
    ollamaAvailable,
    refresh: fetchOllama,
  };
}
