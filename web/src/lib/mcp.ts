"use client";

/**
 * MCP server settings API client. Config is per active project (apiFetch
 * scopes by X-Project-Id) and lives in the project's sandbox/.pi/mcp.json.
 */

import { apiFetch } from "@/lib/projects";

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export type McpServers = Record<string, McpServerConfig>;

export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return "url" in config;
}

export async function getMcpServers(): Promise<McpServers> {
  const res = await apiFetch("/mcp");
  if (!res.ok) throw new Error(`getMcpServers ${res.status}`);
  const data = (await res.json()) as { mcpServers?: McpServers };
  return data.mcpServers ?? {};
}

export async function saveMcpServers(mcpServers: McpServers): Promise<void> {
  const res = await apiFetch("/mcp", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mcpServers }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `saveMcpServers ${res.status}`);
  }
}

export interface McpListing {
  mcpServers: McpServers;
  disabledServers: McpServers;
}

export async function getMcpListing(): Promise<McpListing> {
  const res = await apiFetch("/mcp");
  if (!res.ok) throw new Error(`getMcpListing ${res.status}`);
  const data = (await res.json()) as { mcpServers?: McpServers; disabledServers?: McpServers };
  return { mcpServers: data.mcpServers ?? {}, disabledServers: data.disabledServers ?? {} };
}

export async function setConnectorEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setConnectorEnabled ${res.status}`);
  }
}

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  detail?: string;
}

export async function testMcpServer(
  name: string,
  config: McpServerConfig
): Promise<McpTestResult> {
  const res = await apiFetch("/mcp/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
  return (await res.json()) as McpTestResult;
}
