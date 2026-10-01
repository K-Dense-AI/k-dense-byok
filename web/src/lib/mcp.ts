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

/**
 * How the model reaches a server's tools (Pi's `exposure`; default codemode).
 * `codemode-deferred` is only an alias of `codemode` since Pi 0.99.2: stored
 * configs may still carry it, but the UI no longer offers it.
 */
export type McpExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

export const MCP_EXPOSURE_OPTIONS: { value: McpExposure; label: string; description: string }[] = [
  {
    value: "codemode",
    label: "Codemode",
    description:
      "Pi default. The agent finds the tools by searching and calls them from short scripts, so large tool lists stay out of its context.",
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
  /** What the server offers, in a sentence (Pi's system prompt + tool search ranking). */
  description?: string;
  /** Other Pi fields (type, oauth, cwd, …) are kept verbatim across edits. */
  [key: string]: unknown;
}

/** Pi's OAuth client settings for an HTTP server (all optional). */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  /** `client_name` for dynamic registration, for servers that only accept known clients. */
  clientName?: string;
  /** RFC 8414 / OIDC metadata document used instead of discovery. */
  authServerMetadataUrl?: string;
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
  oauth?: McpOAuthConfig;
  /**
   * Send a Pi provider's `/login` token instead of MCP OAuth. Pi allows it
   * only in the global mcp.json.
   */
  auth?: { provider: string };
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export type McpServers = Record<string, McpServerConfig>;

export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return typeof (config as McpHttpConfig).url === "string";
}

/** The provider whose `/login` token authenticates this server, if any. */
export function authProviderOf(config: McpServerConfig): string | null {
  if (!isHttpConfig(config)) return null;
  const provider = config.auth?.provider;
  return typeof provider === "string" && provider ? provider : null;
}

/**
 * HTTP servers without an Authorization header sign in with OAuth (Pi),
 * unless they send a signed-in provider's token (`auth.provider`).
 */
export function usesOAuth(config: McpServerConfig): boolean {
  return (
    isHttpConfig(config) &&
    !authProviderOf(config) &&
    !Object.keys(config.headers ?? {}).some((h) => h.toLowerCase() === "authorization")
  );
}

export function exposureOf(config: McpServerConfig): McpExposure {
  const exposure = config.exposure ?? "codemode";
  return exposure === "codemode-deferred" ? "codemode" : exposure;
}

/**
 * Pi 1.0 replaces `-` with `_` in tool namespaces (`mcp__my-server__x` is
 * `mcp__my_server__x`), so two names that differ only there would collide.
 */
export function foldedServerName(name: string): string {
  return name.replace(/-/g, "_");
}

/** Another name in `names` that would share `name`'s tool namespace, if any. */
export function namespaceClash(name: string, names: Iterable<string>): string | null {
  const folded = foldedServerName(name);
  for (const other of names) {
    if (other !== name && foldedServerName(other) === folded) return other;
  }
  return null;
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
  /** Pi holds OAuth tokens for this server, so Sign out has something to remove. */
  signedIn?: boolean;
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

/** A Pi provider login an HTTP server can authenticate with (`auth.provider`). */
export interface McpAuthProvider {
  id: string;
  name: string;
  connected: boolean;
}

export async function getMcpAuthProviders(): Promise<McpAuthProvider[]> {
  const res = await apiFetch("/mcp/auth-providers");
  if (!res.ok) throw new Error(await detailOf(res, "getMcpAuthProviders"));
  const data = (await res.json()) as { providers?: McpAuthProvider[] };
  return data.providers ?? [];
}

export interface RadiusConnectorStatus {
  /** Signed in to Radius under Settings → Providers. */
  signedIn: boolean;
  /** A global connector already uses the Radius MCP URL with the Radius login. */
  configured: boolean;
  name: string | null;
  url: string;
}

export async function getRadiusConnector(): Promise<RadiusConnectorStatus> {
  const res = await apiFetch("/mcp/radius");
  if (!res.ok) throw new Error(await detailOf(res, "getRadiusConnector"));
  return (await res.json()) as RadiusConnectorStatus;
}

/** Add (or repoint) the global Radius MCP connector, like Pi's `/login` offer. */
export async function addRadiusConnector(): Promise<{ name: string; replaced: boolean }> {
  const res = await apiFetch("/mcp/radius", { method: "POST" });
  if (!res.ok) throw new Error(await detailOf(res, "addRadiusConnector"));
  const data = (await res.json()) as { name: string; replaced?: boolean };
  return { name: data.name, replaced: data.replaced === true };
}

export interface PaperclipConnectorStatus {
  /** PAPERCLIP_API_KEY is set (Settings → Services, or `.env`). */
  keySet: boolean;
  /** Name of the global connector at the Paperclip MCP URL, if any. */
  name: string | null;
  /** That connector sends PAPERCLIP_API_KEY rather than signing in another way. */
  usesKey: boolean;
  enabled: boolean;
  url: string;
  /** The global mcp.json could not be read. */
  error?: string;
}

export async function getPaperclipConnector(): Promise<PaperclipConnectorStatus> {
  const res = await apiFetch("/mcp/paperclip");
  if (!res.ok) throw new Error(await detailOf(res, "getPaperclipConnector"));
  return (await res.json()) as PaperclipConnectorStatus;
}

/** Point the global Paperclip connector at the saved key and turn it on. */
export async function connectPaperclipConnector(): Promise<{ name: string; replaced: boolean }> {
  const res = await apiFetch("/mcp/paperclip", { method: "POST" });
  if (!res.ok) throw new Error(await detailOf(res, "connectPaperclipConnector"));
  const data = (await res.json()) as { name: string; replaced?: boolean };
  return { name: data.name, replaced: data.replaced === true };
}
