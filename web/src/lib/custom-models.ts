"use client";

/**
 * Custom model servers (Pi models.json) — Settings → Model providers.
 */
import { apiFetch } from "@/lib/projects";

export const CUSTOM_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomModelApi = (typeof CUSTOM_MODEL_APIS)[number];

export interface CustomModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  /** USD per million tokens. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CustomProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomModelApi;
  apiKey?: string;
  models: CustomModelDefinition[];
}

export interface CustomProviderListing extends CustomProvider {
  managed: boolean;
}

export async function getCustomProviders(): Promise<CustomProviderListing[]> {
  const res = await apiFetch("/custom-models");
  if (!res.ok) throw new Error(`getCustomProviders ${res.status}`);
  const data = (await res.json()) as { providers?: CustomProviderListing[] };
  return data.providers ?? [];
}

export async function saveCustomProviders(
  providers: CustomProvider[],
): Promise<{ providers: CustomProviderListing[]; configured: Record<string, boolean> }> {
  const res = await apiFetch("/custom-models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers }),
  });
  const data = (await res.json().catch(() => null)) as
    | { providers?: CustomProviderListing[]; configured?: Record<string, boolean>; detail?: string }
    | null;
  if (!res.ok || !data?.providers) throw new Error(data?.detail || `saveCustomProviders ${res.status}`);
  return { providers: data.providers, configured: data.configured ?? {} };
}
