"use client";

import staticModels from "@/data/models.json";

export type ModelPolicyShape = {
  id: string;
  provider: string;
  pricing: { prompt: number; completion: number };
  isFusion?: boolean;
};

export const MODEL_ACCESS_MODE = process.env.NEXT_PUBLIC_MODEL_ACCESS_MODE ?? "free-local";
export const FREE_LOCAL_ONLY = MODEL_ACCESS_MODE === "free-local";

export function isOpenRouterModel(model: ModelPolicyShape): boolean {
  return model.id.startsWith("openrouter/");
}

export function isFreeOpenRouterModel(model: ModelPolicyShape): boolean {
  return (
    isOpenRouterModel(model) &&
    Number(model.pricing.prompt) === 0 &&
    Number(model.pricing.completion) === 0
  );
}

function isLocalModelId(id: string): boolean {
  return id.startsWith("ollama/") || id.startsWith("mtplx/") || id.startsWith("lightning/");
}

const FREE_OPENROUTER_IDS = new Set(
  (staticModels as ModelPolicyShape[])
    .filter(isFreeOpenRouterModel)
    .map((model) => model.id),
);

export function isAllowedModelForMode(
  model: ModelPolicyShape,
  mode: string = MODEL_ACCESS_MODE,
): boolean {
  if (mode !== "free-local") return true;
  if (model.isFusion || model.id.startsWith("fusion/")) return false;
  return isLocalModelId(model.id) || isFreeOpenRouterModel(model);
}

export function isAllowedModelRefForMode(id: string, mode: string = MODEL_ACCESS_MODE): boolean {
  if (mode !== "free-local") return true;
  return isLocalModelId(id) || FREE_OPENROUTER_IDS.has(id);
}

export const isAllowedModel = isAllowedModelForMode;
export const isAllowedModelRef = isAllowedModelRefForMode;

export function filterAllowedModelsForMode<T extends ModelPolicyShape>(
  models: T[],
  mode: string = MODEL_ACCESS_MODE,
): T[] {
  return models.filter((model) => isAllowedModelForMode(model, mode));
}

export const filterAllowedModels = filterAllowedModelsForMode;
