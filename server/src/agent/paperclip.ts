/**
 * Paperclip (https://paperclip.gxl.ai) literature search as a key-managed MCP
 * connector.
 *
 * Paperclip serves its corpus (papers, preprints, clinical trials, FDA
 * documents, patents) through a remote MCP server, so Kady adds no tool of its
 * own: saving `PAPERCLIP_API_KEY` in Settings → Services writes one global
 * mcp.json entry that Pi's MCP extension connects like any other connector.
 *
 * The entry holds the reference `${PAPERCLIP_API_KEY}`, never the key. Pi
 * resolves it from the environment at connect time
 * (core/resolve-config-value.ts), so the secret stays in `.env`, a new key
 * needs no mcp.json rewrite, and subagent `pi` processes, which read the same
 * global file and inherit our environment, get it too. The header is
 * `X-API-Key`, the one Paperclip documents for its MCP server (`Authorization:
 * Bearer` is documented for the REST API only, where OAuth tokens also travel).
 *
 * Global because the key is the user's, like the Radius connector. Without a
 * key the same URL works as an ordinary OAuth connector (Settings →
 * Connectors, Sign in); saving a key takes that entry over.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  McpConfigError,
  mcpNamespaceClash,
  readGlobalMcpServers,
  sameUrl,
  writeGlobalMcpServers,
  type McpServerConfig,
} from "./mcp.ts";

export const PAPERCLIP_MCP_URL = "https://paperclip.gxl.ai/mcp";
export const PAPERCLIP_API_URL = "https://paperclip.gxl.ai/api/v1";
export const PAPERCLIP_KEY_ENV = "PAPERCLIP_API_KEY";
const KEY_HEADER = "X-API-Key";
const KEY_REFERENCE = `\${${PAPERCLIP_KEY_ENV}}`;
/** Shown in the `mcp_servers` system-prompt section; it also ranks tool search. */
const DESCRIPTION =
  "Paperclip scientific literature: search and read papers, preprints, clinical trials, FDA documents and patents";
const NAMES = ["paperclip", "paperclip-mcp"];

/** A header value that reads the key from the environment (`${VAR}` or `$VAR`). */
const REFERENCES_KEY = new RegExp(`\\$(?:\\{${PAPERCLIP_KEY_ENV}\\}|${PAPERCLIP_KEY_ENV}(?![A-Za-z0-9_]))`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usesKey(config: McpServerConfig): boolean {
  const headers = config.headers;
  return isRecord(headers) && Object.values(headers).some((v) => typeof v === "string" && REFERENCES_KEY.test(v));
}

function findEntry(servers: Record<string, McpServerConfig>): [string, McpServerConfig] | undefined {
  return Object.entries(servers).find(([, config]) => sameUrl(config.url, PAPERCLIP_MCP_URL));
}

export function paperclipKeySet(): boolean {
  return Boolean(process.env[PAPERCLIP_KEY_ENV]?.trim());
}

export interface PaperclipConnectorState {
  /** PAPERCLIP_API_KEY is set (Settings → Services, or `.env`). */
  keySet: boolean;
  /** Name of the global connector at the Paperclip MCP URL, if any. */
  name: string | null;
  /** That connector sends PAPERCLIP_API_KEY (not an OAuth sign-in or a header of its own). */
  usesKey: boolean;
  enabled: boolean;
  url: string;
  /** The global mcp.json could not be read. */
  error?: string;
}

export function paperclipConnectorState(agentDir: string = getAgentDir()): PaperclipConnectorState {
  const base = { keySet: paperclipKeySet(), url: PAPERCLIP_MCP_URL };
  let servers: Record<string, McpServerConfig>;
  try {
    servers = readGlobalMcpServers(agentDir);
  } catch (err) {
    return { ...base, name: null, usesKey: false, enabled: false, error: (err as Error).message };
  }
  const entry = findEntry(servers);
  return {
    ...base,
    name: entry?.[0] ?? null,
    usesKey: entry ? usesKey(entry[1]) : false,
    enabled: entry ? entry[1].enabled !== false : false,
  };
}

/**
 * Point the global Paperclip connector at PAPERCLIP_API_KEY and enable it,
 * adding it when missing. An existing entry at the Paperclip URL keeps its
 * name and settings (exposure, description, timeout, other headers) and loses
 * only the credential it carried: its `oauth` block and any `X-API-Key` or
 * `Authorization` header, since Pi skips OAuth only without the latter.
 * Throws McpConfigError when the global mcp.json is malformed.
 */
export function connectPaperclipKey(agentDir: string = getAgentDir()): { name: string; replaced: boolean } {
  const servers = readGlobalMcpServers(agentDir);
  const existing = findEntry(servers);
  let name = existing?.[0];
  if (!name) {
    name = NAMES.find((candidate) => !(candidate in servers) && !mcpNamespaceClash(candidate, Object.keys(servers)));
    if (!name) throw new McpConfigError(`The connector names ${NAMES.join(" and ")} are taken; rename one to add Paperclip`);
  }
  const { oauth: _oauth, enabled: _enabled, headers, ...rest } = existing?.[1] ?? { url: PAPERCLIP_MCP_URL };
  const kept = Object.entries(isRecord(headers) ? headers : {}).filter(
    ([header]) => !["x-api-key", "authorization"].includes(header.toLowerCase()),
  );
  const config: McpServerConfig = {
    ...rest,
    description: rest.description ?? DESCRIPTION,
    headers: { ...Object.fromEntries(kept), [KEY_HEADER]: KEY_REFERENCE },
  };
  writeGlobalMcpServers({ ...servers, [name]: config }, agentDir);
  return { name, replaced: Boolean(existing) };
}

/**
 * Turn the key-backed connector off once the key is gone: an unset `${VAR}`
 * makes Pi refuse to connect, which would show as a failed server in every
 * tab. Kept, not deleted, so its settings survive a later key. An entry that
 * signs in another way does not need the key and is left alone.
 */
export function disconnectPaperclipKey(agentDir: string = getAgentDir()): { name: string | null } {
  const servers = readGlobalMcpServers(agentDir);
  const existing = findEntry(servers);
  if (!existing || !usesKey(existing[1]) || existing[1].enabled === false) return { name: null };
  writeGlobalMcpServers({ ...servers, [existing[0]]: { ...existing[1], enabled: false } }, agentDir);
  return { name: existing[0] };
}

const CHECK_TIMEOUT_MS = 15_000;

/**
 * Check a key with one authenticated metadata read of a document id that does
 * not exist: Paperclip authenticates before routing, so 401/403 means the key
 * was refused and a 404 (or a 400 for the id) means it was accepted. Throws a
 * user-facing message otherwise.
 */
export async function validatePaperclipApiKey(key: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${PAPERCLIP_API_URL}/documents/kady-key-check`, {
      headers: { [KEY_HEADER]: key, Accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach Paperclip to check the key: ${(err as Error).message}`);
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) {
    throw new Error("Paperclip rejected this API key. Check it at https://paperclip.gxl.ai/keys.");
  }
  if (res.ok || [400, 404, 422].includes(res.status)) return;
  throw new Error(`Paperclip could not check the key right now (HTTP ${res.status}); try again shortly.`);
}
