/**
 * MCP connectors on Pi's built-in MCP support: config file editing (both
 * scopes), the legacy disabled-store migration, validation, the `pi mcp` CLI
 * bridge (status + test dial, against a dependency-free stdio fixture), the
 * Settings routes, and a real lead session connecting a configured server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  RADIUS_MCP_URL,
  addRadiusConnector,
  getMcpStatus,
  mcpConfigPath,
  mcpNamespace,
  mcpNamespaceClash,
  radiusConnectorState,
  migrateDisabledMcpServers,
  readMcpServers,
  setMcpServerEnabled,
  setMcpServerExposure,
  testMcpServer,
  validateMcpServer,
  writeMcpServers,
} from "../src/agent/mcp.ts";
import { buildApp } from "../src/index.ts";
import { createSession, disposeProjectSessions } from "../src/agent/session-registry.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "echo-mcp-server.mjs");
const echoServer = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  ...extra,
});

async function reset(): Promise<void> {
  // Windows may briefly retain directory handles after child processes exit.
  await fs.promises.rm(PROJECTS_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(path.join(getAgentDir(), "mcp.json"), { force: true });
}
beforeEach(reset);
afterAll(async () => {
  // Windows may briefly retain directory handles after child processes exit.
  await fs.promises.rm(PROJECTS_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(path.join(getAgentDir(), "mcp.json"), { force: true });
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
}

describe("mcp.json editing", () => {
  it("round-trips both scopes and keeps Pi fields and other top-level keys", () => {
    const paths = ensureProjectExists("p1");
    const projectFile = mcpConfigPath("project", paths);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }));

    writeMcpServers("project", paths, {
      docs: { url: "https://example.com/mcp", exposure: "direct", oauth: { scope: "read" }, timeout: 30 },
    });
    writeMcpServers("global", paths, { gh: echoServer({ toolExposure: { "delete_*": "hidden" } }) });

    expect(readJson(projectFile).autoEnableCodemode).toBe(false);
    expect(readMcpServers("project", paths).docs).toEqual({
      url: "https://example.com/mcp",
      exposure: "direct",
      oauth: { scope: "read" },
      timeout: 30,
    });
    expect(readMcpServers("global", paths).gh.toolExposure).toEqual({ "delete_*": "hidden" });
    expect(mcpConfigPath("global", paths)).toBe(path.join(getAgentDir(), "mcp.json"));
  });

  it("toggles with Pi's `enabled: false` flag and writes exposure like /mcp does", () => {
    const paths = ensureProjectExists("p2");
    writeMcpServers("project", paths, { gh: echoServer() });

    expect(setMcpServerEnabled("project", paths, "gh", false)).toEqual({ ok: true });
    expect(readMcpServers("project", paths).gh.enabled).toBe(false);
    expect(setMcpServerEnabled("project", paths, "gh", true)).toEqual({ ok: true });
    expect("enabled" in readMcpServers("project", paths).gh).toBe(false);

    expect(setMcpServerExposure("project", paths, "gh", "deferred")).toEqual({ ok: true });
    expect(readMcpServers("project", paths).gh.exposure).toBe("deferred");
    // codemode is Pi's default: the key is removed rather than written.
    expect(setMcpServerExposure("project", paths, "gh", "codemode")).toEqual({ ok: true });
    expect("exposure" in readMcpServers("project", paths).gh).toBe(false);

    expect(setMcpServerEnabled("project", paths, "ghost", false)).toMatchObject({ ok: false, status: 404 });
    expect(setMcpServerEnabled("global", paths, "gh", false)).toMatchObject({ ok: false, status: 404 });
  });

  it("never rewrites a malformed file", () => {
    const paths = ensureProjectExists("p3");
    const file = mcpConfigPath("project", paths);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(() => readMcpServers("project", paths)).toThrow(/not valid JSON/);
    expect(() => writeMcpServers("project", paths, {})).toThrow(/not valid JSON/);
    expect(setMcpServerEnabled("project", paths, "x", false)).toMatchObject({ ok: false, status: 409 });
    expect(fs.readFileSync(file, "utf-8")).toBe("{not json");
  });

  it("folds the legacy mcp-disabled.json into mcp.json as disabled entries", () => {
    const paths = ensureProjectExists("p4");
    writeMcpServers("project", paths, { live: { url: "https://new.example/mcp" } });
    const legacy = path.join(paths.sandbox, ".pi", "mcp-disabled.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        mcpServers: {
          gh: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "t" } },
          live: { url: "https://stale.example/mcp" },
        },
      }),
    );

    migrateDisabledMcpServers(paths);

    const servers = readMcpServers("project", paths);
    expect(servers.gh).toEqual({
      command: "npx",
      args: ["-y", "server-github"],
      env: { GITHUB_TOKEN: "t" },
      enabled: false,
    });
    // The live entry wins; the stale copy is kept aside, not lost.
    expect(servers.live).toEqual({ url: "https://new.example/mcp" });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readJson(`${legacy}.conflict`)).toEqual({
      mcpServers: { live: { url: "https://stale.example/mcp" } },
    });
    migrateDisabledMcpServers(paths); // idempotent
    expect(readMcpServers("project", paths).gh.enabled).toBe(false);
  });
});

describe("validateMcpServer", () => {
  it.each([
    ["bad name!", { url: "https://x/mcp" }, /Invalid server name/],
    ["a", {}, /exactly one of/],
    ["a", { url: "https://x/mcp", command: "npx" }, /exactly one of/],
    ["a", { url: "https://x/sse", type: "sse" }, /SSE transport is not supported/],
    ["a", { command: "npx", type: "http" }, /"type" must be "stdio"/],
    ["a", { url: "ftp://x" }, /http or https/],
    ["a", { url: "https://x/mcp", headers: { A: 1 } }, /headers/],
    ["a", { url: "https://x/mcp", oauth: { callbackPort: 70000 } }, /callbackPort/],
    ["a", { command: "npx", args: "-y x" }, /args/],
    ["a", { command: "npx", exposure: "everywhere" }, /exposure/],
    ["a", { command: "npx", toolExposure: { x: "nope" } }, /toolExposure/],
    ["a", { command: "npx", timeout: 0 }, /timeout/],
    ["a", { command: "npx", enabled: "no" }, /enabled/],
    ["a", { command: "npx", description: 7 }, /description/],
    ["a", { url: "https://x/mcp", oauth: { clientName: " " } }, /clientName/],
    ["a", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "http://idp.example/.well-known" } }, /authServerMetadataUrl/],
    ["a", { url: "https://x/mcp", oauth: { callbackUrl: "https://localhost/cb" } }, /callbackUrl/],
    ["a", { url: "https://x/mcp", oauth: { callbackUrl: "http://localhost:8080/cb", callbackPort: 9090 } }, /different ports/],
    ["a", { url: "https://x/mcp", auth: { provider: "" } }, /auth\.provider/],
    ["a", { url: "http://remote.example/mcp", auth: { provider: "radius" } }, /requires an https URL/],
  ])("rejects %s %j", (name, config, message) => {
    expect(validateMcpServer(name, config)).toMatch(message);
  });

  it("keeps provider sign-ins out of project files, like Pi's loader", () => {
    const radius = { url: "https://radius.pi.dev/mcp", auth: { provider: "radius" } };
    expect(validateMcpServer("radius", radius, "global")).toBeNull();
    expect(validateMcpServer("radius", radius, "project")).toMatch(/shared across projects/);
    expect(validateMcpServer("dev", { url: "http://127.0.0.1:8080/mcp", auth: { provider: "radius" } }, "global")).toBeNull();
  });

  it("folds - into _ for tool namespaces, like Pi 0.99.2+", () => {
    expect(mcpNamespace("my-server")).toBe("mcp__my_server");
    expect(mcpNamespaceClash("my-server", ["my_server", "other"])).toBe("my_server");
    expect(mcpNamespaceClash("my-server", ["my-server", "other"])).toBeUndefined();
  });

  it("accepts Pi's full entry shapes", () => {
    expect(
      validateMcpServer("docs", {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
        oauth: {
          clientId: "c", callbackPort: 8765, scope: "read write", clientName: "Kady",
          authServerMetadataUrl: "https://idp.example/.well-known/oauth-authorization-server",
          callbackUrl: "http://localhost:8765/callback",
        },
        description: "Search the team's documentation.",
        exposure: "deferred",
        toolExposure: { search: "direct", "delete_*": "hidden" },
        timeout: 90,
        enabled: false,
      }),
    ).toBeNull();
    expect(validateMcpServer("fs", { command: "npx", args: ["-y", "x"], env: { K: "v" }, cwd: "." })).toBeNull();
  });
});

describe("pi mcp CLI bridge", () => {
  it("reports both scopes the way a session sees them", async () => {
    // Not trusted yet (no chat opened): the status call trusts it itself.
    const paths = ensureProjectExists("p5");
    writeMcpServers("project", paths, {
      echo: echoServer(),
      off: { command: "definitely-not-a-binary", enabled: false },
    });
    writeMcpServers("global", paths, {
      gecho: echoServer({ exposure: "direct" }),
      echo: { url: "https://shadowed.example/mcp" },
    });

    const report = await getMcpStatus(paths);
    const byName = Object.fromEntries(report.servers.map((s) => [s.name, s]));
    expect(byName.echo).toMatchObject({ scope: "project", state: "connected", tools: ["echo", "add"] });
    expect(byName.gecho).toMatchObject({ scope: "global", exposure: "direct", state: "connected" });
    expect(byName.off).toMatchObject({ enabled: false, state: "disabled" });
    // The project entry replaces the global one of the same name.
    expect(report.servers.filter((s) => s.name === "echo")).toHaveLength(1);
  }, 60_000);

  it("reports which HTTP servers Pi holds OAuth tokens for", async () => {
    const paths = ensureProjectExists("p7");
    // Disabled, so nothing is dialled: the sign-in state comes from the files.
    writeMcpServers("global", paths, {
      "signed-in": { url: "https://docs.example/mcp", enabled: false },
      legacy: { url: "https://legacy.example/mcp", enabled: false },
      keyed: { url: "https://keyed.example/mcp", headers: { "X-API-Key": "${KEY}" }, enabled: false },
      local: { ...echoServer(), enabled: false },
    });
    // Write tokens with Pi's own (unexported) store, so a change to its key
    // format fails here instead of hiding Sign out for signed-in connectors.
    const oauthModule = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "extensions",
      "mcp",
      "oauth.js",
    );
    const { McpOAuthCredentialStore } = await import(pathToFileURL(oauthModule).href);
    const authFile = path.join(getAgentDir(), "mcp-auth.json");
    try {
      await new McpOAuthCredentialStore().forServer("signed-in", "https://docs.example/mcp").save({
        tokens: { access_token: "a", token_type: "Bearer" },
      });
      // Older Pi versions keyed state by URL alone.
      const states = readJson(authFile);
      states["https://legacy.example/mcp"] = { tokens: { access_token: "b", token_type: "Bearer" } };
      fs.writeFileSync(authFile, JSON.stringify(states));

      const byName = Object.fromEntries((await getMcpStatus(paths)).servers.map((s) => [s.name, s]));
      expect(byName["signed-in"].signedIn).toBe(true);
      expect(byName.legacy.signedIn).toBe(true);
      expect(byName.keyed.signedIn).toBe(false);
      expect(byName.local.signedIn).toBeUndefined();
    } finally {
      fs.rmSync(authFile, { force: true });
    }
  }, 60_000);

  it("test-dials an unsaved entry and reports failures as states", async () => {
    const paths = ensureProjectExists("p6");
    expect(await testMcpServer("x", echoServer(), paths)).toMatchObject({
      state: "connected",
      tools: ["echo", "add"],
    });
    const failed = await testMcpServer("y", { command: "definitely-not-a-binary" }, paths);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(process.platform === "win32" ? /not recognized/ : /ENOENT/);
  }, 60_000);
});

describe("MCP routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });
  const headers = { "x-project-id": "r1", "content-type": "application/json" };

  it("edits a scope, flags names shared with the other scope, and validates", async () => {
    ensureProjectExists("r1");
    let res = await app.inject({
      method: "PUT",
      url: "/mcp?scope=global",
      headers,
      payload: { mcpServers: { shared: { url: "https://g.example/mcp" } } },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "PUT",
      url: "/mcp",
      headers,
      payload: { mcpServers: { shared: echoServer(), local: echoServer() } },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: "GET", url: "/mcp", headers });
    expect(res.json()).toMatchObject({ scope: "project", overridesGlobal: ["shared"] });
    res = await app.inject({ method: "GET", url: "/mcp?scope=global", headers });
    expect(res.json()).toMatchObject({ scope: "global", overriddenByProject: ["shared"] });

    res = await app.inject({ method: "POST", url: "/mcp/local/disable", headers: { "x-project-id": "r1" } });
    expect(res.statusCode).toBe(200);
    expect(readMcpServers("project", resolvePaths("r1")).local.enabled).toBe(false);
    res = await app.inject({ method: "POST", url: "/mcp/local/exposure", headers, payload: { exposure: "direct" } });
    expect(res.statusCode).toBe(200);
    expect(readMcpServers("project", resolvePaths("r1")).local.exposure).toBe("direct");

    res = await app.inject({ method: "POST", url: "/mcp/local/exposure", headers, payload: { exposure: "loud" } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "GET", url: "/mcp?scope=team", headers });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "PUT",
      url: "/mcp",
      headers,
      payload: { mcpServers: { bad: { url: "https://x/sse", type: "sse" } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects names Pi would fold into one namespace, within and across scopes", async () => {
    ensureProjectExists("r1");
    let res = await app.inject({
      method: "PUT", url: "/mcp", headers,
      payload: { mcpServers: { "lab-tools": echoServer(), lab_tools: echoServer() } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/would share tool names/);
    res = await app.inject({
      method: "PUT", url: "/mcp?scope=global", headers,
      payload: { mcpServers: { lab_tools: { url: "https://g.example/mcp" } } },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "PUT", url: "/mcp", headers, payload: { mcpServers: { "lab-tools": echoServer() } } });
    expect(res.statusCode).toBe(400);
    // The exact same name is a deliberate project replacement, not a clash.
    res = await app.inject({ method: "PUT", url: "/mcp", headers, payload: { mcpServers: { lab_tools: echoServer() } } });
    expect(res.statusCode).toBe(200);
    // Provider sign-ins are refused in the project file.
    res = await app.inject({
      method: "PUT", url: "/mcp", headers,
      payload: { mcpServers: { radius: { url: RADIUS_MCP_URL, auth: { provider: "radius" } } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists provider sign-ins with Radius first and gates the Radius connector on its sign-in", async () => {
    ensureProjectExists("r1");
    let res = await app.inject({ method: "GET", url: "/mcp/auth-providers", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers[0]).toMatchObject({ id: "radius", name: "Radius" });
    res = await app.inject({ method: "GET", url: "/mcp/radius", headers });
    expect(res.json()).toMatchObject({ configured: false, name: null, url: RADIUS_MCP_URL });
    if (!res.json().signedIn) {
      res = await app.inject({ method: "POST", url: "/mcp/radius", headers: { "x-project-id": "r1" } });
      expect(res.statusCode).toBe(409);
    }
  });

  it("test route reports a connection or a readable failure", async () => {
    ensureProjectExists("r1");
    let res = await app.inject({ method: "POST", url: "/mcp/test", headers, payload: { name: "e", config: echoServer() } });
    expect(res.json()).toMatchObject({ ok: true, tools: ["echo", "add"] });
    res = await app.inject({
      method: "POST",
      url: "/mcp/test",
      headers,
      payload: { name: "e", config: { command: "definitely-not-a-binary" } },
    });
    expect(res.json()).toMatchObject({ ok: false, state: "failed" });
  }, 60_000);
});

describe("Radius connector", () => {
  it("adds the global connector once and reuses an entry at the Radius URL, as Pi's /login offer does", () => {
    const paths = ensureProjectExists("rad");
    expect(radiusConnectorState(paths, true)).toMatchObject({ signedIn: true, configured: false, name: null });
    // `radius` is taken by another server, so Pi's fallback name is used.
    writeMcpServers("global", paths, { radius: { url: "https://elsewhere.example/mcp" } });
    expect(addRadiusConnector(paths)).toEqual({ name: "radius-mcp", replaced: false });
    expect(readMcpServers("global", paths)["radius-mcp"]).toEqual({ url: RADIUS_MCP_URL, auth: { provider: "radius" } });
    expect(radiusConnectorState(paths, true)).toMatchObject({ configured: true, name: "radius-mcp" });

    // An existing OAuth entry at the Radius URL keeps its settings and loses only `oauth`.
    writeMcpServers("global", paths, { gateway: { url: `${RADIUS_MCP_URL}/`, oauth: { clientId: "x" }, exposure: "direct" } });
    expect(addRadiusConnector(paths)).toEqual({ name: "gateway", replaced: true });
    expect(readMcpServers("global", paths).gateway).toEqual({ url: `${RADIUS_MCP_URL}/`, exposure: "direct", auth: { provider: "radius" } });
  });
});

describe("lead session", () => {
  afterEach(() => disposeProjectSessions("s1"));

  it("connects configured servers through Pi and exposes their tools", async () => {
    const paths = ensureProjectExists("s1");
    writeMcpServers("project", paths, {
      echo: echoServer(),
      direct: echoServer({ exposure: "direct" }),
      "lab-direct": echoServer({ exposure: "direct", description: "Echo fixture for lab tests." }),
      off: echoServer({ enabled: false }),
    });
    const session = await createSession("s1", paths);
    await expect
      .poll(() => session.getActiveToolNames(), { timeout: 15_000, interval: 100 })
      .toContain("mcp__direct__echo");
    // Pi 0.99.2+ replaces `-` with `_` in MCP tool and namespace names.
    await expect
      .poll(() => session.getActiveToolNames(), { timeout: 15_000, interval: 100 })
      .toContain(`${mcpNamespace("lab-direct")}__echo`);

    const active = session.getActiveToolNames();
    // Default (codemode) exposure: callable from scripts, not declared, and
    // the MCP extension switched the codemode tool on for it.
    expect(active).toContain("codemode");
    expect(active).not.toContain("mcp__echo__echo");
    expect(session.getCallableToolNames()).toContain("mcp__echo__echo");
    expect(session.getCallableToolNames().some((n) => n.startsWith("mcp__off__"))).toBe(false);
    // The denylist keeps the lead's own tools and hides the lazy loaders.
    for (const name of ["grep", "find", "ls", "subagent", "bg_wait", "web_search", "interview", "notebook"]) {
      expect(active).toContain(name);
    }
    expect(active).not.toContain("subagents_enable");
    expect(active).not.toContain("web_enable");
  }, 30_000);
});
