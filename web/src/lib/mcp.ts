"use client";

/**
 * MCP server settings API client. Kady's agent uses Pi's built-in MCP
 * support, which reads two `mcp.json` files: the active project's
 * `sandbox/.pi/mcp.json` (scope "project"; apiFetch scopes by X-Project-Id)
 * and `~/.kady/pi-agent/mcp.json` (scope "global", every project). A project
 * entry replaces a global entry with the same name.
 */

import { apiFetch } from "@/lib/projects";

export type McpScope = "project" | "global";

/** How the model reaches a server's tools (Pi's `exposure`; default codemode). */
export type McpExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

export const MCP_EXPOSURE_OPTIONS: { value: McpExposure; label: string; description: string }[] = [
  {
    value: "codemode",
    label: "Codemode",
    description:
      "Pi default. The agent calls the tools from short scripts, which keeps large tool lists out of its context.",
  },
  {
    value: "codemode-deferred",
    label: "Codemode (searched)",
    description: "Like codemode, but the tools are not listed; scripts search for them. For large, rarely used servers.",
  },
  {
    value: "deferred",
    label: "On demand",
    description: "Hidden until the agent loads them with tool search, then called directly.",
  },
  {
    value: "direct",
    label: "Direct",
    description: "Declared to the agent like its built-in tools. Best for small servers and simpler models.",
  },
  { value: "hidden", label: "Hidden", description: "Connected, but no tool can be called." },
];

interface McpBaseConfig {
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  enabled?: boolean;
  timeout?: number;
  /** Other Pi fields (type, oauth, cwd, …) are kept verbatim across edits. */
  [key: string]: unknown;
}

export interface McpStdioConfig extends McpBaseConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig extends McpBaseConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export type McpServers = Record<string, McpServerConfig>;

export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return typeof (config as McpHttpConfig).url === "string";
}

/** HTTP servers without an Authorization header sign in with OAuth (Pi). */
export function usesOAuth(config: McpServerConfig): boolean {
  return (
    isHttpConfig(config) &&
    !Object.keys(config.headers ?? {}).some((h) => h.toLowerCase() === "authorization")
  );
}

export function exposureOf(config: McpServerConfig): McpExposure {
  return config.exposure ?? "codemode";
}

async function detailOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { detail?: string } | null;
  return data?.detail || `${fallback} ${res.status}`;
}

export interface McpListing {
  mcpServers: McpServers;
  /** Config file the scope is stored in. */
  path?: string;
  /**
   * Names defined in both scopes. In the project scope these replace the
   * global entry; in the global scope they are replaced for this project.
   */
  shared: string[];
}

export async function getMcpListing(scope: McpScope = "project"): Promise<McpListing> {
  const res = await apiFetch(`/mcp?scope=${scope}`);
  if (!res.ok) throw new Error(await detailOf(res, "getMcpListing"));
  const data = (await res.json()) as {
    mcpServers?: McpServers;
    path?: string;
    overridesGlobal?: string[];
    overriddenByProject?: string[];
  };
  return {
    mcpServers: data.mcpServers ?? {},
    path: data.path,
    shared: data.overridesGlobal ?? data.overriddenByProject ?? [],
  };
}

export async function saveMcpServers(mcpServers: McpServers, scope: McpScope = "project"): Promise<void> {
  const res = await apiFetch(`/mcp?scope=${scope}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mcpServers }),
  });
  if (!res.ok) throw new Error(await detailOf(res, "saveMcpServers"));
}

export async function setConnectorEnabled(
  name: string,
  enabled: boolean,
  scope: McpScope = "project",
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/${action}?scope=${scope}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await detailOf(res, "setConnectorEnabled"));
}

export async function setConnectorExposure(
  name: string,
  exposure: McpExposure,
  scope: McpScope = "project",
): Promise<void> {
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/exposure?scope=${scope}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exposure }),
  });
  if (!res.ok) throw new Error(await detailOf(res, "setConnectorExposure"));
}

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  enabled: boolean;
  exposure: McpExposure;
  /** connected, needs-auth, failed, disconnected, disabled, … */
  state: string;
  tools: string[];
  resources?: number;
  error?: string;
}

export interface McpStatusReport {
  servers: McpServerStatus[];
  errors: string[];
  note?: string;
}

/** Connect every server this project's chats would see and report its state. Slow. */
export async function getMcpStatus(): Promise<McpStatusReport> {
  const res = await apiFetch("/mcp/status", { method: "POST" });
  if (!res.ok) throw new Error(await detailOf(res, "getMcpStatus"));
  return (await res.json()) as McpStatusReport;
}

export interface McpTestResult {
  ok: boolean;
  state?: string;
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

export interface McpLoginFlow {
  status: "running" | "complete" | "error";
  authorizationUrl?: string;
  message?: string;
}

/** Start an OAuth sign-in (Pi opens the browser; the URL is returned as a fallback). */
export async function startMcpLogin(name: string): Promise<McpLoginFlow> {
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/login`, { method: "POST" });
  if (!res.ok) throw new Error(await detailOf(res, "startMcpLogin"));
  return (await res.json()) as McpLoginFlow;
}

export async function getMcpLogin(name: string): Promise<McpLoginFlow | null> {
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/login`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await detailOf(res, "getMcpLogin"));
  return (await res.json()) as McpLoginFlow;
}

export async function cancelMcpLogin(name: string): Promise<void> {
  await apiFetch(`/mcp/${encodeURIComponent(name)}/login`, { method: "DELETE" });
}

export async function mcpLogout(name: string): Promise<void> {
  const res = await apiFetch(`/mcp/${encodeURIComponent(name)}/logout`, { method: "POST" });
  if (!res.ok) throw new Error(await detailOf(res, "mcpLogout"));
}
