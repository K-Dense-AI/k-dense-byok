/**
 * MCP server settings endpoints (per active project).
 *
 * Backs the Settings → "MCP servers" panel: read/write the project's
 * `sandbox/.pi/mcp.json` and test-dial a server config before saving.
 * Tokens in the config stay on this machine — the file is local and the
 * API only serves the user's own browser.
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import {
  disableMcpServer,
  enableMcpServer,
  readMcpConfig,
  readMcpDisabled,
  testMcpServer,
  writeMcpConfig,
  type McpServerConfig,
} from "../agent/mcp.ts";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validate one server entry; returns an error message or null when valid. */
function validateServer(name: string, config: unknown): string | null {
  if (!NAME_RE.test(name)) {
    return `Invalid server name "${name}" (use letters, digits, - and _)`;
  }
  if (!config || typeof config !== "object") return `Server "${name}": config must be an object`;
  const c = config as Record<string, unknown>;
  const hasUrl = typeof c.url === "string" && c.url.trim() !== "";
  const hasCommand = typeof c.command === "string" && c.command.trim() !== "";
  if (hasUrl === hasCommand) {
    return `Server "${name}": provide exactly one of "url" (HTTP) or "command" (stdio)`;
  }
  if (hasUrl) {
    try {
      new URL(c.url as string);
    } catch {
      return `Server "${name}": invalid URL`;
    }
    if (c.headers !== undefined && !isStringRecord(c.headers)) {
      return `Server "${name}": "headers" must be an object of strings`;
    }
  } else {
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"))) {
      return `Server "${name}": "args" must be an array of strings`;
    }
    if (c.env !== undefined && !isStringRecord(c.env)) {
      return `Server "${name}": "env" must be an object of strings`;
    }
  }
  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mcp", async () => {
    const paths = activePaths();
    return { mcpServers: readMcpConfig(paths), disabledServers: readMcpDisabled(paths) };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/enable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = enableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/disable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = disableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.put<{ Body: { mcpServers?: Record<string, unknown> } }>("/mcp", async (req, reply) => {
    const servers = (req.body ?? {}).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      reply.code(400);
      return { detail: "Body must be { mcpServers: { <name>: <config> } }" };
    }
    for (const [name, config] of Object.entries(servers)) {
      const error = validateServer(name, config);
      if (error) {
        reply.code(400);
        return { detail: error };
      }
    }
    writeMcpConfig(activePaths(), servers as Record<string, McpServerConfig>);
    return { ok: true, mcpServers: servers };
  });

  // Dial a (possibly unsaved) server config and report its tools, so the UI
  // can offer "Test connection" before the user commits a token typo.
  app.post<{ Body: { name?: string; config?: unknown } }>("/mcp/test", async (req, reply) => {
    const { name = "server", config } = req.body ?? {};
    const error = validateServer(NAME_RE.test(name) ? name : "server", config);
    if (error) {
      reply.code(400);
      return { ok: false, detail: error };
    }
    try {
      const { tools } = await testMcpServer(name, config as McpServerConfig, activePaths().sandbox);
      return { ok: true, tools };
    } catch (err) {
      // Connection failures are an expected outcome of "test", not a 5xx.
      return { ok: false, detail: (err as Error).message };
    }
  });
}
