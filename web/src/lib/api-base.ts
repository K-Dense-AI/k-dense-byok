const LOCAL_API_BASE = "http://localhost:8000";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

export function getApiBaseUrl(): string {
  const configuredBase = process.env.NEXT_PUBLIC_ADK_API_URL?.trim();
  if (configuredBase) {
    return trimTrailingSlashes(configuredBase);
  }

  if (typeof window === "undefined") {
    return LOCAL_API_BASE;
  }

  if (LOCAL_HOSTNAMES.has(window.location.hostname)) {
    return LOCAL_API_BASE;
  }

  return trimTrailingSlashes(window.location.origin);
}
