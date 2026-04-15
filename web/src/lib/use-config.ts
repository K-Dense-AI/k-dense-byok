"use client";

import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/api-base";

export interface AppConfig {
  modalConfigured: boolean;
}

const DEFAULT_CONFIG: AppConfig = { modalConfigured: false };

export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBaseUrl()}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setConfig({ modalConfigured: !!data.modal_configured });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return config;
}
