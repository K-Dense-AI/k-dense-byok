"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/projects";

export const PROVIDER_AUTH_CHANGED_EVENT = "kady:provider-auth-changed";

export type ProviderBillingMode = "metered_oauth" | "subscription";

export interface ModelProviderStatus {
  id: "openai-codex" | "anthropic" | "github-copilot" | "xai";
  name: string;
  accountLabel: string;
  billingMode: ProviderBillingMode;
  billingNote: string;
  connected: boolean;
  needsReauth?: boolean;
  credentialType: "oauth" | "api_key" | null;
  source: string | null;
  loginLabel: string | null;
  modelCount: number;
}

export type ProviderAuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type ProviderAuthPrompt =
  | {
      id: string;
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | {
      id: string;
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    };

export interface ProviderAuthFlow {
  id: string;
  providerId: ModelProviderStatus["id"];
  status:
    | "running"
    | "awaiting_input"
    | "complete"
    | "error"
    | "cancelled"
    | "expired";
  events: ProviderAuthEvent[];
  prompt?: ProviderAuthPrompt;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

async function jsonOrError<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    | (T & { detail?: string })
    | null;
  if (!response.ok) {
    throw new Error(data?.detail || `Request failed (${response.status})`);
  }
  if (!data) throw new Error("Server returned an empty response");
  return data;
}

export function notifyProviderAuthChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT));
  }
}

export function useProviderAuth() {
  const [providers, setProviders] = useState<ModelProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("/model-providers");
      const data = await jsonOrError<{ providers: ModelProviderStatus[] }>(response);
      if (requestId !== refreshId.current) return;
      setProviders(Array.isArray(data.providers) ? data.providers : []);
    } catch (cause) {
      if (requestId !== refreshId.current) return;
      setError(cause instanceof Error ? cause.message : "Failed to load model providers");
    } finally {
      if (requestId === refreshId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const start = useCallback(async (providerId: ModelProviderStatus["id"]) => {
    const response = await apiFetch("/model-auth/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    return jsonOrError<ProviderAuthFlow>(response);
  }, []);

  const poll = useCallback(async (flowId: string) => {
    const response = await apiFetch(`/model-auth/flows/${encodeURIComponent(flowId)}`);
    return jsonOrError<ProviderAuthFlow>(response);
  }, []);

  const respond = useCallback(
    async (flowId: string, promptId: string, value: string) => {
      const response = await apiFetch(
        `/model-auth/flows/${encodeURIComponent(flowId)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promptId, value }),
        },
      );
      return jsonOrError<ProviderAuthFlow>(response);
    },
    [],
  );

  const cancel = useCallback(async (flowId: string) => {
    const response = await apiFetch(`/model-auth/flows/${encodeURIComponent(flowId)}`, {
      method: "DELETE",
    });
    return jsonOrError<ProviderAuthFlow>(response);
  }, []);

  const logout = useCallback(
    async (providerId: ModelProviderStatus["id"]) => {
      const response = await apiFetch(
        `/model-providers/${encodeURIComponent(providerId)}/credential`,
        { method: "DELETE" },
      );
      await jsonOrError<{ ok: boolean }>(response);
      notifyProviderAuthChanged();
    },
    [],
  );

  return {
    providers,
    loading,
    error,
    refresh,
    start,
    poll,
    respond,
    cancel,
    logout,
  };
}
