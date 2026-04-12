"use client";

import { useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";

export interface AppConfig {
  modalConfigured: boolean;
  veniceConfigured: boolean;
}

const DEFAULT_CONFIG: AppConfig = { modalConfigured: false, veniceConfigured: false };

export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setConfig({
            modalConfigured: !!data.modal_configured,
            veniceConfigured: !!data.venice_configured,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return config;
}
