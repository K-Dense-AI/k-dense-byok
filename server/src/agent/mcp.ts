/**
 * MCP bridge: expose Model Context Protocol servers as Pi custom tools.
 *
 * Pi has no built-in MCP support, so each configured server is dialed with the
 * official MCP SDK and every tool it advertises is wrapped as a Pi
 * `ToolDefinition` named `mcp__<server>__<tool>`.
 *
 * Configuration lives per project at `sandbox/.pi/mcp.json` (same convention
 * as Claude Desktop / Claude Code):
 *
 *   {
 *     "mcpServers": {
 *       "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *                    "env": { "GITHUB_TOKEN": "..." } },
 *       "linear":  { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "..." } }
 *     }
 *   }
 *
 * `command` entries use stdio transport; `url` entries use streamable HTTP.
 * Clients are cached per project and reconnected when mcp.json changes.
 * A server that fails to connect is skipped with a warning — it never blocks
 * session creation.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ProjectPaths } from "../projects.ts";
import type { ToggleResult } from "./capability-state.ts";

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface ProjectMcpState {
  /** Raw mcp.json text the clients were built from; reconnect when it changes. */
  configText: string;
  clients: Client[];
  tools: ToolDefinition[];
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

const stateByProject = new Map<string, ProjectMcpState>();

function mcpConfigPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "mcp.json");
}

function readConfigText(paths: ProjectPaths): string {
  try {
    return fs.readFileSync(mcpConfigPath(paths), "utf-8");
  } catch {
    return "";
  }
}

function parseConfig(text: string): Record<string, McpServerConfig> {
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text) as McpConfigFile;
    if (data && typeof data === "object" && data.mcpServers) return data.mcpServers;
  } catch (err) {
    console.warn(`[mcp] ignoring malformed mcp.json: ${String(err)}`);
  }
  return {};
}

/** Tool names must satisfy provider naming rules; keep [a-zA-Z0-9_-]. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<Client> {
  const client = new Client({ name: "kady-server", version: "0.5.0" });
  const transport =
    "url" in config
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        })
      : new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...config.env } as Record<string, string>,
          cwd,
          stderr: "ignore",
        });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
}

function wrapTool(
  serverName: string,
  client: Client,
  tool: { name: string; description?: string; inputSchema: unknown },
): ToolDefinition {
  const parameters = (tool.inputSchema ?? {
    type: "object",
    properties: {},
  }) as TSchema;
  return {
    name: `mcp__${sanitizeName(serverName)}__${sanitizeName(tool.name)}`,
    label: `${serverName}: ${tool.name}`,
    description: tool.description ?? `${tool.name} (MCP server: ${serverName})`,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await client.callTool(
        { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: CALL_TIMEOUT_MS, signal },
      );
      const blocks = Array.isArray(result.content) ? result.content : [];
      const content = blocks
        .map((block) => {
          if (block.type === "text") return { type: "text" as const, text: block.text };
          if (block.type === "image") {
            return { type: "image" as const, data: block.data, mimeType: block.mimeType };
          }
          // resource/audio/etc. — pass through as JSON so the model sees something
          return { type: "text" as const, text: JSON.stringify(block) };
        })
        .filter(Boolean);
      if (content.length === 0) content.push({ type: "text", text: "(no content)" });
      return {
        content,
        isError: Boolean(result.isError),
        details: undefined,
      };
    },
  };
}

async function buildState(paths: ProjectPaths, configText: string): Promise<ProjectMcpState> {
  const servers = parseConfig(configText);
  const clients: Client[] = [];
  const tools: ToolDefinition[] = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      try {
        const client = await connectServer(name, config, paths.sandbox);
        clients.push(client);
        const { tools: serverTools } = await client.listTools();
        for (const t of serverTools) tools.push(wrapTool(name, client, t));
      } catch (err) {
        console.warn(`[mcp] server "${name}" unavailable, skipping: ${String(err)}`);
      }
    }),
  );
  return { configText, clients, tools };
}

/**
 * Tools for every MCP server configured in the project's mcp.json.
 * Cached per project; clients are rebuilt when the config file changes.
 */
export async function getMcpTools(
  projectId: string,
  paths: ProjectPaths,
): Promise<ToolDefinition[]> {
  const configText = readConfigText(paths);
  const cached = stateByProject.get(projectId);
  if (cached && cached.configText === configText) return cached.tools;
  if (cached) await closeClients(cached);
  const state = await buildState(paths, configText);
  stateByProject.set(projectId, state);
  return state.tools;
}

async function closeClients(state: ProjectMcpState): Promise<void> {
  await Promise.all(
    state.clients.map((c) => c.close().catch(() => {/* best-effort */})),
  );
}

/** Close a project's MCP clients (e.g. on project delete). Best-effort. */
export async function disposeMcpClients(projectId: string): Promise<void> {
  const state = stateByProject.get(projectId);
  if (!state) return;
  stateByProject.delete(projectId);
  await closeClients(state);
}

// --- config CRUD + connection test (used by the settings API) -------------

/** Parsed mcp.json servers for a project ({} when missing/malformed). */
export function readMcpConfig(paths: ProjectPaths): Record<string, McpServerConfig> {
  return parseConfig(readConfigText(paths));
}

/**
 * Persist the full server map to the project's mcp.json (atomic write). The
 * next session build sees a changed configText and reconnects clients.
 */
export function writeMcpConfig(
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
): void {
  const file = mcpConfigPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function mcpDisabledPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "mcp-disabled.json");
}

/** Parsed disabled-server map for a project ({} when missing/malformed). */
export function readMcpDisabled(paths: ProjectPaths): Record<string, McpServerConfig> {
  try {
    return parseConfig(fs.readFileSync(mcpDisabledPath(paths), "utf-8"));
  } catch {
    return {};
  }
}

/** Persist the disabled-server map (atomic write), mirroring mcp.json's shape. */
export function writeMcpDisabled(
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
): void {
  const file = mcpDisabledPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function moveServer(
  paths: ProjectPaths,
  name: string,
  from: "enabled" | "disabled",
): ToggleResult {
  const enabled = readMcpConfig(paths);
  const disabled = readMcpDisabled(paths);
  const src = from === "enabled" ? enabled : disabled;
  const dst = from === "enabled" ? disabled : enabled;
  if (!(name in src)) {
    return { ok: false, status: 404, detail: `No ${from} connector named "${name}"` };
  }
  dst[name] = src[name];
  delete src[name];
  writeMcpConfig(paths, enabled);
  writeMcpDisabled(paths, disabled);
  return { ok: true };
}

/** Move an enabled server into the disabled store (keeps its config + token). */
export function disableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "enabled");
}

/** Move a disabled server back into mcp.json. */
export function enableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "disabled");
}

/** Dial a server config once and report its tools; always closes the client. */
export async function testMcpServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<{ tools: string[] }> {
  const client = await connectServer(name, config, cwd);
  try {
    const { tools } = await client.listTools();
    return { tools: tools.map((t) => t.name) };
  } finally {
    await client.close().catch(() => {/* best-effort */});
  }
}
