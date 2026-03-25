"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";

export interface UseCustomMcpsReturn {
  /** Raw JSON string of the user's custom MCP servers. */
  value: string;
  /** Whether the initial load is still in progress. */
  loading: boolean;
  /** Whether a save request is in flight. */
  saving: boolean;
  /** Error message from the most recent load or save, if any. */
  error: string | null;
  /** Persist new custom MCP JSON to the backend. */
  save: (json: string) => Promise<boolean>;
  /** Re-fetch the current value from the backend. */
  refresh: () => void;
}

export function useCustomMcps(): UseCustomMcpsReturn {
  const [value, setValue] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMcps = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/settings/mcps`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setValue(JSON.stringify(data, null, 2));
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchMcps();
  }, [fetchMcps]);

  const save = useCallback(async (json: string): Promise<boolean> => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError("Invalid JSON");
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Must be a JSON object");
      return false;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/settings/mcps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: json,
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `HTTP ${res.status}`);
      }
      setValue(JSON.stringify(parsed, null, 2));
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { value, loading, saving, error, save, refresh: fetchMcps };
}
