export interface RuntimeConfig { apiBase?: string; packaged?: boolean }
declare global { interface Window { __KADY_RUNTIME__?: RuntimeConfig } }

export function runtimeApiBase(config?: RuntimeConfig): string {
  const value = config?.apiBase;
  if (value) {
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.toString().replace(/\/$/, "");
    } catch { /* Fall back to the configured source-install address. */ }
  }
  return process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";
}
