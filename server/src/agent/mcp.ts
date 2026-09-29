/**
 * MCP (Model Context Protocol) servers, backed by Pi's built-in MCP support.
 *
 * Pi 0.99 ships MCP as an extension (https://pi.dev/docs/latest/mcp): the lead
 * session loads `createMcpExtension()` (session-registry.ts), which connects
 * the servers in two `mcp.json` files on session_start and registers their
 * tools as `mcp__<server>__<tool>`:
 *
 *   - global:  `<agentDir>/mcp.json` (`~/.kady/pi-agent/mcp.json`), every project
 *   - project: `sandbox/.pi/mcp.json`, read because Kady trusts its sandboxes;
 *              an entry here replaces a global entry with the same name.
 *
 * Kady no longer dials servers itself. This module only edits those files for
 * Settings → Connectors (Pi's `mcpServers` shape, with its `enabled`,
 * `exposure`, `toolExposure`, `timeout`, `cwd` and `oauth` fields kept intact)
 * and drives the bundled `pi mcp` CLI for what needs a live connection:
 * status (`pi mcp list --json`), a connection test of an unsaved entry, and
 * OAuth sign-in/out (`pi mcp login|logout`, tokens in `<agentDir>/mcp-auth.json`).
 *
 * Sessions read the files when they start, so edits apply to new chat tabs.
 * A sign-in reaches running tabs too: Pi reconnects servers that were waiting
 * for one on their next turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicJson } from "../atomic-json.ts";
import type { ProjectPaths } from "../projects.ts";
import type { ToggleResult } from "./capability-state.ts";
import { trustSandbox } from "./web-access-bridge.ts";

export type McpScope = "project" | "global";

export const MCP_EXPOSURES = [
  "codemode",
  "codemode-deferred",
  "deferred",
  "direct",
  "hidden",
] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** One `mcpServers` entry, as stored (unknown keys are preserved on rewrite). */
export type McpServerConfig = Record<string, unknown>;

/** Pi's rule for server names; tools become `mcp__<name>__<tool>`. */
export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isMcpScope(value: unknown): value is McpScope {
  return value === "project" || value === "global";
}

export function mcpConfigPath(
  scope: McpScope,
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): string {
  return scope === "global"
    ? path.join(agentDir, "mcp.json")
    : path.join(paths.sandbox, ".pi", "mcp.json");
}

interface McpFile {
  servers: Record<string, McpServerConfig>;
  /** Other top-level keys (e.g. `autoEnableCodemode`), written back unchanged. */
  rest: Record<string, unknown>;
  /** Set when the file exists but is not a JSON object; it is never rewritten. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMcpFile(file: string): McpFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {}, rest: {} };
    return { servers: {}, rest: {}, error: `Cannot read ${file}: ${(err as Error).message}` };
  }
  if (!text.trim()) return { servers: {}, rest: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { servers: {}, rest: {}, error: `${file} is not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecord(data)) return { servers: {}, rest: {}, error: `${file} must contain a JSON object` };
  const { mcpServers, ...rest } = data;
  if (mcpServers !== undefined && !isRecord(mcpServers)) {
    return { servers: {}, rest, error: `${file}: "mcpServers" must be an object` };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers ?? {})) {
    if (isRecord(config)) servers[name] = config;
  }
  return { servers, rest };
}

function writeMcpFile(file: string, current: McpFile, servers: Record<string, McpServerConfig>): void {
  // Owner-only: entries may carry tokens in `env` or `headers`.
  atomicJson(file, { ...current.rest, mcpServers: servers });
}

export class McpConfigError extends Error {}

/** Servers defined in one scope's mcp.json. Throws McpConfigError when it is malformed. */
export function readMcpServers(
  scope: McpScope,
  paths: ProjectPaths,
  agentDir?: string,
): Record<string, McpServerConfig> {
  const file = readMcpFile(mcpConfigPath(scope, paths, agentDir));
  if (file.error) throw new McpConfigError(file.error);
  return file.servers;
}

/** Replace one scope's server map, keeping the file's other top-level keys. */
export function writeMcpServers(
  scope: McpScope,
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
  agentDir?: string,
): void {
  const filePath = mcpConfigPath(scope, paths, agentDir);
  const file = readMcpFile(filePath);
  if (file.error) throw new McpConfigError(file.error);
  writeMcpFile(filePath, file, servers);
}

function patchServer(
  scope: McpScope,
  paths: ProjectPaths,
  name: string,
  patch: (config: McpServerConfig) => McpServerConfig,
  agentDir?: string,
): ToggleResult {
  const filePath = mcpConfigPath(scope, paths, agentDir);
  const file = readMcpFile(filePath);
  if (file.error) return { ok: false, status: 409, detail: file.error };
  const config = file.servers[name];
  if (!config) return { ok: false, status: 404, detail: `No ${scope} connector named "${name}"` };
  writeMcpFile(filePath, file, { ...file.servers, [name]: patch(config) });
  return { ok: true };
}

/**
 * Enable or disable a server in place. Like Pi's `/mcp` manager, the default
 * (`enabled: true`) removes the key rather than writing it.
 */
export function setMcpServerEnabled(
  scope: McpScope,
  paths: ProjectPaths,
  name: string,
  enabled: boolean,
  agentDir?: string,
): ToggleResult {
  return patchServer(scope, paths, name, (config) => {
    const { enabled: _previous, ...rest } = config;
    return enabled ? rest : { ...rest, enabled: false };
  }, agentDir);
}

/** Set a server's exposure; `codemode` is Pi's default and removes the key. */
export function setMcpServerExposure(
  scope: McpScope,
  paths: ProjectPaths,
  name: string,
  exposure: McpExposure,
  agentDir?: string,
): ToggleResult {
  return patchServer(scope, paths, name, (config) => {
    const { exposure: _previous, ...rest } = config;
    return exposure === "codemode" ? rest : { ...rest, exposure };
  }, agentDir);
}

/**
 * Fold `sandbox/.pi/mcp-disabled.json` (Kady's pre-Pi-MCP disabled store) into
 * the project mcp.json as `enabled: false` entries, then remove it. A name
 * already in mcp.json keeps that live entry; the stale disabled copy stays in
 * the old file (renamed `.conflict`) so nothing is lost. Idempotent.
 */
export function migrateDisabledMcpServers(paths: ProjectPaths): void {
  const legacyPath = path.join(paths.sandbox, ".pi", "mcp-disabled.json");
  if (!fs.existsSync(legacyPath)) return;
  const legacy = readMcpFile(legacyPath);
  const livePath = mcpConfigPath("project", paths);
  const live = readMcpFile(livePath);
  if (legacy.error || live.error) {
    console.warn(`[mcp] not migrating ${legacyPath}: ${legacy.error ?? live.error}`);
    return;
  }
  const servers = { ...live.servers };
  const conflicts: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(legacy.servers)) {
    if (name in servers) conflicts[name] = config;
    else servers[name] = { ...config, enabled: false };
  }
  writeMcpFile(livePath, live, servers);
  if (Object.keys(conflicts).length > 0) {
    atomicJson(`${legacyPath}.conflict`, { mcpServers: conflicts });
    console.warn(
      `[mcp] ${Object.keys(conflicts).join(", ")} exist in both mcp.json and mcp-disabled.json; ` +
        `kept the mcp.json entries and saved the others to ${legacyPath}.conflict`,
    );
  }
  fs.rmSync(legacyPath, { force: true });
}

// --- validation ------------------------------------------------------------

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/**
 * Validate one entry against Pi's `mcpServers` rules (mcp.md). Pi also skips
 * invalid entries at load time; checking here turns a silent skip into a
 * Settings error. Returns a message, or null when valid.
 */
export function validateMcpServer(name: string, config: unknown): string | null {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return `Invalid server name "${name}" (use letters, digits, - and _)`;
  }
  if (!isRecord(config)) return `Server "${name}": config must be an object`;
  const c = config;
  const hasUrl = typeof c.url === "string" && c.url.trim() !== "";
  const hasCommand = typeof c.command === "string" && c.command.trim() !== "";
  if (hasUrl === hasCommand) {
    return `Server "${name}": provide exactly one of "url" (HTTP) or "command" (stdio)`;
  }
  if (c.type !== undefined) {
    if (c.type === "sse") {
      return `Server "${name}": the SSE transport is not supported; most servers also serve streamable HTTP, often at /mcp`;
    }
    const valid = hasUrl ? ["http", "streamable-http"] : ["stdio"];
    if (!valid.includes(c.type as string)) {
      return `Server "${name}": "type" must be ${valid.map((t) => `"${t}"`).join(" or ")} for a ${hasUrl ? "url" : "command"} server`;
    }
  }
  if (hasUrl) {
    try {
      const url = new URL(c.url as string);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return `Server "${name}": URL must use http or https`;
      }
    } catch {
      return `Server "${name}": invalid URL`;
    }
    if (c.headers !== undefined && !isStringRecord(c.headers)) {
      return `Server "${name}": "headers" must be an object of strings`;
    }
    if (c.oauth !== undefined) {
      if (!isRecord(c.oauth)) return `Server "${name}": "oauth" must be an object`;
      for (const key of ["clientId", "clientSecret", "callbackUrl", "scope"]) {
        if (c.oauth[key] !== undefined && typeof c.oauth[key] !== "string") {
          return `Server "${name}": "oauth.${key}" must be a string`;
        }
      }
      const port = c.oauth.callbackPort;
      if (port !== undefined && !(Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)) {
        return `Server "${name}": "oauth.callbackPort" must be a port number`;
      }
    }
  } else {
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"))) {
      return `Server "${name}": "args" must be an array of strings`;
    }
    if (c.env !== undefined && !isStringRecord(c.env)) {
      return `Server "${name}": "env" must be an object of strings`;
    }
    if (c.cwd !== undefined && typeof c.cwd !== "string") {
      return `Server "${name}": "cwd" must be a string`;
    }
  }
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
    return `Server "${name}": "enabled" must be true or false`;
  }
  if (c.timeout !== undefined && !(typeof c.timeout === "number" && c.timeout > 0)) {
    return `Server "${name}": "timeout" must be a positive number of seconds`;
  }
  const exposures: readonly unknown[] = MCP_EXPOSURES;
  if (c.exposure !== undefined && !exposures.includes(c.exposure)) {
    return `Server "${name}": "exposure" must be one of ${MCP_EXPOSURES.join(", ")}`;
  }
  if (c.toolExposure !== undefined) {
    if (!isRecord(c.toolExposure) || !Object.values(c.toolExposure).every((v) => exposures.includes(v))) {
      return `Server "${name}": "toolExposure" values must be one of ${MCP_EXPOSURES.join(", ")}`;
    }
  }
  return null;
}

// --- the `pi mcp` CLI --------------------------------------------------------

/** The installed Pi CLI entry point (dist/cli.js beside the SDK's index.js). */
export function piCliPath(): string {
  const index = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return path.join(path.dirname(index), "cli.js");
}

function piCliEnv(agentDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `pi mcp list` connects every enabled server, so allow for slow stdio startups (npx, uvx). */
const LIST_TIMEOUT_MS = 120_000;

function runPiMcp(args: string[], cwd: string, agentDir: string, timeoutMs = LIST_TIMEOUT_MS): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [piCliPath(), "mcp", ...args], {
      cwd,
      env: piCliEnv(agentDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  source: string;
  enabled: boolean;
  exposure: McpExposure;
  transport: string;
  /** Pi's connection state: connected, needs-auth, failed, disconnected, … or "disabled". */
  state: string;
  tools: string[];
  toolExposure?: Record<string, McpExposure>;
  resources?: number;
  resourceTemplates?: number;
  error?: string;
}

export interface McpStatusReport {
  servers: McpServerStatus[];
  /** Config problems Pi found (invalid entries are skipped, not fatal). */
  errors: string[];
  note?: string;
}

function parseListReport(result: CliResult): McpStatusReport {
  // `pi mcp list --json` exits 1 while anything is wrong but still prints the report.
  const start = result.stdout.indexOf("{");
  if (start >= 0) {
    try {
      const data = JSON.parse(result.stdout.slice(start)) as McpStatusReport;
      if (Array.isArray(data.servers)) {
        return { servers: data.servers, errors: data.errors ?? [], ...(data.note ? { note: data.note } : {}) };
      }
    } catch {
      /* fall through */
    }
  }
  const detail = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
  throw new Error(`pi mcp list failed: ${detail}`);
}

/**
 * Connect every configured server (both scopes, as a session would) once and
 * report its state and tools. Servers are closed again afterwards.
 */
export async function getMcpStatus(paths: ProjectPaths, agentDir: string = getAgentDir()): Promise<McpStatusReport> {
  // The CLI reads a project mcp.json only in trusted projects. Session builds
  // trust the sandbox too, but a project may not have opened a chat yet.
  trustSandbox(paths, agentDir);
  return parseListReport(await runPiMcp(["list", "--json"], paths.sandbox, agentDir));
}

/**
 * Dial one (possibly unsaved) entry with Pi's own client and transports.
 * Runs `pi mcp list` against a throwaway agent directory holding only this
 * entry, plus a copy of the stored OAuth tokens so a signed-in server tests
 * as signed in; the project's own mcp.json is not read there (untrusted).
 */
export async function testMcpServer(
  name: string,
  config: McpServerConfig,
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): Promise<McpServerStatus> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-mcp-test-"));
  try {
    atomicJson(path.join(tmp, "mcp.json"), { mcpServers: { [name]: { ...config, enabled: true } } });
    const tokens = path.join(agentDir, "mcp-auth.json");
    if (fs.existsSync(tokens)) {
      fs.copyFileSync(tokens, path.join(tmp, "mcp-auth.json"));
      fs.chmodSync(path.join(tmp, "mcp-auth.json"), 0o600);
    }
    const report = parseListReport(await runPiMcp(["list", "--json"], paths.sandbox, tmp));
    const server = report.servers.find((s) => s.name === name);
    if (!server) throw new Error(report.errors[0] ?? `Pi did not load server "${name}"`);
    return server;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- OAuth sign-in -----------------------------------------------------------

export interface McpLoginFlow {
  status: "running" | "complete" | "error";
  /** The authorization page, once the CLI printed it (it also opens the browser). */
  authorizationUrl?: string;
  message?: string;
  startedAt: number;
}

interface LoginFlowState extends McpLoginFlow {
  child?: ChildProcess;
}

/** How long `pi mcp login` waits for the browser callback. */
const LOGIN_TIMEOUT_SECONDS = 300;
/** Finished flows stay readable this long so the UI can pick up the result. */
const FLOW_RETENTION_MS = 10 * 60_000;

const loginFlows = new Map<string, LoginFlowState>();

function flowKey(projectId: string, name: string): string {
  return `${projectId}\0${name}`;
}

function publicFlow(flow: LoginFlowState): McpLoginFlow {
  const { child: _child, ...rest } = flow;
  return rest;
}

/**
 * Start `pi mcp login <name>` for the project's view of the server (a project
 * entry wins over a global one of the same name). The CLI opens the browser
 * and waits for the loopback callback; tokens land in `<agentDir>/mcp-auth.json`,
 * shared by every project. A new start cancels a flow still running.
 */
export function startMcpLogin(
  projectId: string,
  name: string,
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): McpLoginFlow {
  const key = flowKey(projectId, name);
  loginFlows.get(key)?.child?.kill("SIGTERM");
  trustSandbox(paths, agentDir);
  const flow: LoginFlowState = { status: "running", startedAt: Date.now() };
  loginFlows.set(key, flow);
  const child = spawn(
    process.execPath,
    [piCliPath(), "mcp", "login", name, "--timeout", String(LOGIN_TIMEOUT_SECONDS)],
    { cwd: paths.sandbox, env: piCliEnv(agentDir), stdio: ["ignore", "pipe", "pipe"] },
  );
  flow.child = child;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
    flow.authorizationUrl ??= stdout.match(/in your browser:\s*\n(\S+)/)?.[1];
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
  const finish = (status: "complete" | "error", message: string) => {
    if (loginFlows.get(key) !== flow) return;
    flow.status = status;
    flow.message = message;
    flow.child = undefined;
    setTimeout(() => {
      if (loginFlows.get(key) === flow) loginFlows.delete(key);
    }, FLOW_RETENTION_MS).unref();
  };
  child.on("error", (err) => finish("error", err.message));
  child.on("close", (code) => {
    const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "";
    if (code === 0) finish("complete", lastLine(stdout) || "Signed in.");
    else finish("error", lastLine(stderr) || lastLine(stdout) || `Sign-in exited with code ${code}`);
  });
  return publicFlow(flow);
}

export function getMcpLoginFlow(projectId: string, name: string): McpLoginFlow | null {
  const flow = loginFlows.get(flowKey(projectId, name));
  return flow ? publicFlow(flow) : null;
}

export function cancelMcpLogin(projectId: string, name: string): void {
  const key = flowKey(projectId, name);
  loginFlows.get(key)?.child?.kill("SIGTERM");
  loginFlows.delete(key);
}

/** Delete a server's stored OAuth tokens (`pi mcp logout`). */
export async function mcpLogout(
  name: string,
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): Promise<{ ok: boolean; message: string }> {
  trustSandbox(paths, agentDir);
  const result = await runPiMcp(["logout", name], paths.sandbox, agentDir, 30_000);
  const message = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim();
  return { ok: result.code === 0, message };
}
