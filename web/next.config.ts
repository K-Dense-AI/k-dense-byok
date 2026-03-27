import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

function readVersionFromPyproject(): string {
  try {
    const content = readFileSync(resolve(__dirname, "..", "pyproject.toml"), "utf-8");
    const match = content.match(/^version\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Internal backend URL used by Next.js server-side rewrites.
// On Railway (and local Docker) both services run in the same container.
const ADK_API_URL = process.env.ADK_API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: readVersionFromPyproject(),
  },
  // Proxy all backend API paths through Next.js so the browser only ever
  // talks to one origin. This enables Railway (and any reverse-proxy) to
  // work without extra CORS configuration.
  async rewrites() {
    return [
      { source: "/run_sse", destination: `${ADK_API_URL}/run_sse` },
      { source: "/apps/:path*", destination: `${ADK_API_URL}/apps/:path*` },
      { source: "/health", destination: `${ADK_API_URL}/health` },
      { source: "/config", destination: `${ADK_API_URL}/config` },
      { source: "/skills", destination: `${ADK_API_URL}/skills` },
      { source: "/sandbox/:path*", destination: `${ADK_API_URL}/sandbox/:path*` },
      { source: "/settings/:path*", destination: `${ADK_API_URL}/settings/:path*` },
    ];
  },
};

export default nextConfig;
