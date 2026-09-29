/**
 * MCP server settings endpoints (Settings → Connectors).
 *
 * Edits the two `mcp.json` files Pi's MCP extension reads — `?scope=project`
 * (default; the active project's `sandbox/.pi/mcp.json`) or `?scope=global`
 * (`<agentDir>/mcp.json`, every project) — and exposes the live-connection
 * operations Pi's `pi mcp` CLI provides: status, a test dial of an unsaved
 * entry, and OAuth sign-in/out. Tokens in the files stay on this machine; the
 * API only serves the user's own browser.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { activePaths } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import {
  MCP_EXPOSURES,
  MCP_SERVER_NAME_RE,
  McpConfigError,
  cancelMcpLogin,
  getMcpLoginFlow,
  getMcpStatus,
  isMcpScope,
  mcpConfigPath,
  mcpLogout,
  migrateDisabledMcpServers,
  readMcpServers,
  setMcpServerEnabled,
  setMcpServerExposure,
  startMcpLogin,
  testMcpServer,
  validateMcpServer,
  writeMcpServers,
  type McpExposure,
  type McpScope,
  type McpServerConfig,
} from "../agent/mcp.ts";

interface ScopeQuery {
  scope?: string;
}

function scopeOf(query: ScopeQuery, reply: FastifyReply): McpScope | null {
  const scope = query.scope ?? "project";
  if (isMcpScope(scope)) return scope;
  reply.code(400);
  return null;
}

function badName(name: string, reply: FastifyReply): { detail: string } | null {
  if (MCP_SERVER_NAME_RE.test(name)) return null;
  reply.code(400);
  return { detail: `Invalid server name "${name}"` };
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  // One scope's servers plus, for the UI, the names the other scope shares:
  // a project entry replaces a global entry with the same name.
  app.get<{ Querystring: ScopeQuery }>("/mcp", async (req, reply) => {
    const scope = scopeOf(req.query, reply);
    if (!scope) return { detail: `Invalid scope "${req.query.scope}"` };
    const paths = activePaths();
    migrateDisabledMcpServers(paths);
    const other: McpScope = scope === "project" ? "global" : "project";
    try {
      const mcpServers = readMcpServers(scope, paths);
      let otherNames: string[] = [];
      try {
        otherNames = Object.keys(readMcpServers(other, paths));
      } catch {
        /* the other file's problem is reported when that scope is opened */
      }
      const shared = Object.keys(mcpServers).filter((name) => otherNames.includes(name));
      return {
        scope,
        path: mcpConfigPath(scope, paths),
        mcpServers,
        // project view: these replace a global entry; global view: these are replaced here.
        [scope === "project" ? "overridesGlobal" : "overriddenByProject"]: shared,
      };
    } catch (err) {
      if (!(err instanceof McpConfigError)) throw err;
      reply.code(409);
      return { detail: err.message, path: mcpConfigPath(scope, paths) };
    }
  });

  app.put<{ Querystring: ScopeQuery; Body: { mcpServers?: Record<string, unknown> } }>(
    "/mcp",
    async (req, reply) => {
      const scope = scopeOf(req.query, reply);
      if (!scope) return { detail: `Invalid scope "${req.query.scope}"` };
      const servers = (req.body ?? {}).mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        reply.code(400);
        return { detail: "Body must be { mcpServers: { <name>: <config> } }" };
      }
      for (const [name, config] of Object.entries(servers)) {
        const error = validateMcpServer(name, config);
        if (error) {
          reply.code(400);
          return { detail: error };
        }
      }
      try {
        writeMcpServers(scope, activePaths(), servers as Record<string, McpServerConfig>);
      } catch (err) {
        if (!(err instanceof McpConfigError)) throw err;
        reply.code(409);
        return { detail: err.message };
      }
      return { ok: true, mcpServers: servers };
    },
  );

  for (const action of ["enable", "disable"] as const) {
    app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
      `/mcp/:name/${action}`,
      async (req, reply) => {
        const scope = scopeOf(req.query, reply);
        if (!scope) return { detail: `Invalid scope "${req.query.scope}"` };
        const invalid = badName(req.params.name, reply);
        if (invalid) return invalid;
        const r = setMcpServerEnabled(scope, activePaths(), req.params.name, action === "enable");
        if (!r.ok) {
          reply.code(r.status);
          return { detail: r.detail };
        }
        return { ok: true };
      },
    );
  }

  app.post<{ Params: { name: string }; Querystring: ScopeQuery; Body: { exposure?: unknown } }>(
    "/mcp/:name/exposure",
    async (req, reply) => {
      const scope = scopeOf(req.query, reply);
      if (!scope) return { detail: `Invalid scope "${req.query.scope}"` };
      const invalid = badName(req.params.name, reply);
      if (invalid) return invalid;
      const exposure = req.body?.exposure;
      if (!(MCP_EXPOSURES as readonly unknown[]).includes(exposure)) {
        reply.code(400);
        return { detail: `"exposure" must be one of ${MCP_EXPOSURES.join(", ")}` };
      }
      const r = setMcpServerExposure(scope, activePaths(), req.params.name, exposure as McpExposure);
      if (!r.ok) {
        reply.code(r.status);
        return { detail: r.detail };
      }
      return { ok: true };
    },
  );

  // Connect every server the active project's sessions would see (both
  // scopes) and report state and tools. Slow by nature: it starts stdio servers.
  app.get("/mcp/status", async (_req, reply) => {
    try {
      return await getMcpStatus(activePaths());
    } catch (err) {
      reply.code(502);
      return { detail: (err as Error).message };
    }
  });

  // Dial a (possibly unsaved) server config and report its tools, so the UI
  // can offer "Test connection" before the user commits a token typo.
  app.post<{ Body: { name?: string; config?: unknown } }>("/mcp/test", async (req, reply) => {
    const { config } = req.body ?? {};
    const name = MCP_SERVER_NAME_RE.test(req.body?.name ?? "") ? (req.body?.name as string) : "server";
    const error = validateMcpServer(name, config);
    if (error) {
      reply.code(400);
      return { ok: false, detail: error };
    }
    try {
      const status = await testMcpServer(name, config as McpServerConfig, activePaths());
      if (status.state === "connected") return { ok: true, tools: status.tools, state: status.state };
      return {
        ok: false,
        state: status.state,
        tools: status.tools,
        detail:
          status.state === "needs-auth"
            ? "The server requires sign-in. Save it, then use Sign in."
            : (status.error ?? `Server is ${status.state}`),
      };
    } catch (err) {
      // Connection failures are an expected outcome of "test", not a 5xx.
      return { ok: false, detail: (err as Error).message };
    }
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/login", async (req, reply) => {
    const invalid = badName(req.params.name, reply);
    if (invalid) return invalid;
    const projectId = currentProjectId();
    const started = startMcpLogin(projectId, req.params.name, activePaths());
    // Give the CLI up to 10s to print the authorization URL (or fail) so the
    // UI can offer the link; the flow keeps running and is polled via GET.
    for (let i = 0; i < 40; i++) {
      const current = getMcpLoginFlow(projectId, req.params.name);
      if (!current || current.authorizationUrl || current.status !== "running") return current ?? started;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return getMcpLoginFlow(projectId, req.params.name) ?? started;
  });

  app.get<{ Params: { name: string } }>("/mcp/:name/login", async (req, reply) => {
    const invalid = badName(req.params.name, reply);
    if (invalid) return invalid;
    const flow = getMcpLoginFlow(currentProjectId(), req.params.name);
    if (!flow) {
      reply.code(404);
      return { detail: "No sign-in in progress" };
    }
    return flow;
  });

  app.delete<{ Params: { name: string } }>("/mcp/:name/login", async (req, reply) => {
    const invalid = badName(req.params.name, reply);
    if (invalid) return invalid;
    cancelMcpLogin(currentProjectId(), req.params.name);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/logout", async (req, reply) => {
    const invalid = badName(req.params.name, reply);
    if (invalid) return invalid;
    const result = await mcpLogout(req.params.name, activePaths());
    if (!result.ok) reply.code(400);
    return result.ok ? { ok: true, message: result.message } : { detail: result.message };
  });
}
