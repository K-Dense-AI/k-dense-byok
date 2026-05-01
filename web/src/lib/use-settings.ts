"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, onProjectChange } from "@/lib/projects";

export interface McpServerStatus {
  /** Server key in the merged settings.json (e.g. "paperclip"). */
  name: string;
  /** "http" for streamable / SSE servers, "stdio" otherwise. */
  transport: "http" | "stdio";
  /** Connection URL for HTTP transports; null for stdio. */
  url: string | null;
  /** True when the server is one Kady ships by default. */
  builtin: boolean;
  /**
   * null = stdio (auth doesn't apply); true/false = whether we have a
   * stored OAuth token for this server.
   */
  signedIn: boolean | null;
  /**
   * True when the server replied 401 to an unauthenticated probe -- i.e.
   * an OAuth flow is required to make it usable.
   */
  needsAuth: boolean;
  /** Safe metadata about the stored token (no secrets). */
  tokenInfo: {
    issuer?: string | null;
    obtainedAt?: number | null;
    expiresAt?: number | null;
    tokenType?: string;
    hasRefreshToken?: boolean;
  } | null;
}

export interface UseMcpStatusReturn {
  servers: McpServerStatus[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Kick off OAuth for ``name``. Returns the authorize URL on success. */
  signIn: (name: string) => Promise<string | null>;
  /** Drop the stored token for ``name``. */
  signOut: (name: string) => Promise<boolean>;
}

/**
 * Live view of every configured MCP server (defaults + custom) plus its
 * auth status. Mirrors GET /settings/mcps/status on the backend.
 */
export function useMcpStatus(): UseMcpStatusReturn {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/settings/mcps/status`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: { servers?: McpServerStatus[] }) => {
        setServers(Array.isArray(data.servers) ? data.servers : []);
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => onProjectChange(() => fetchStatus()), [fetchStatus]);

  const signIn = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        const res = await apiFetch(
          `/settings/mcps/${encodeURIComponent(name)}/sign-in`,
          { method: "POST" },
        );
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(detail || `HTTP ${res.status}`);
        }
        const body: { authUrl?: string } = await res.json();
        return body.authUrl ?? null;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Sign-in failed");
        return null;
      }
    },
    [],
  );

  const signOut = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const res = await apiFetch(
          `/settings/mcps/${encodeURIComponent(name)}/sign-out`,
          { method: "POST" },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        fetchStatus();
        return true;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Sign-out failed");
        return false;
      }
    },
    [fetchStatus],
  );

  return { servers, loading, error, refresh: fetchStatus, signIn, signOut };
}


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
    apiFetch(`/settings/mcps`)
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

  useEffect(() => onProjectChange(() => fetchMcps()), [fetchMcps]);

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
      const res = await apiFetch(`/settings/mcps`, {
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

export interface BrowserUseConfig {
  enabled: boolean;
  headed: boolean;
  profile: string | null;
  session: string | null;
}

export const DEFAULT_BROWSER_USE_CONFIG: BrowserUseConfig = {
  enabled: true,
  headed: false,
  profile: null,
  session: null,
};

export interface UseBrowserUseSettingsReturn {
  config: BrowserUseConfig;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (patch: Partial<BrowserUseConfig>) => Promise<boolean>;
  refresh: () => void;
}

export function useBrowserUseSettings(): UseBrowserUseSettingsReturn {
  const [config, setConfig] = useState<BrowserUseConfig>(
    DEFAULT_BROWSER_USE_CONFIG,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/settings/browser-use`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: { config?: Partial<BrowserUseConfig> }) => {
        setConfig({ ...DEFAULT_BROWSER_USE_CONFIG, ...(data.config ?? {}) });
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => onProjectChange(() => fetchConfig()), [fetchConfig]);

  const save = useCallback(
    async (patch: Partial<BrowserUseConfig>): Promise<boolean> => {
      setError(null);
      setSaving(true);
      const next: BrowserUseConfig = { ...config, ...patch };
      try {
        const res = await apiFetch(`/settings/browser-use`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(detail || `HTTP ${res.status}`);
        }
        const data: { config?: Partial<BrowserUseConfig> } = await res
          .json()
          .catch(() => ({}));
        setConfig({ ...DEFAULT_BROWSER_USE_CONFIG, ...(data.config ?? next) });
        return true;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Save failed");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [config],
  );

  return { config, loading, saving, error, save, refresh: fetchConfig };
}

export interface ChromeProfile {
  /** Directory name under Chrome's user-data dir (passed to --profile). */
  id: string;
  /** Display name shown in Chrome (falls back to the directory name). */
  name: string;
  /** Google account email when signed-in; null otherwise. */
  email: string | null;
  /** Absolute path to the profile directory on disk. */
  path: string;
}

export interface UseChromeProfilesReturn {
  profiles: ChromeProfile[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch Chrome profiles installed on the user's machine.
 *
 * Returns an empty array when Chrome isn't installed. The list is
 * machine-scoped, so no project-change refetch is needed.
 */
export function useChromeProfiles(): UseChromeProfilesReturn {
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfiles = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/system/chrome-profiles`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: { profiles?: ChromeProfile[] }) => {
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  return { profiles, loading, error, refresh: fetchProfiles };
}
