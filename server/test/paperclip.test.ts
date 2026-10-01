/**
 * Paperclip literature search as a key-managed global MCP connector: the
 * mcp.json entry a saved key adds (a `${PAPERCLIP_API_KEY}` reference, never
 * the key), takeover of an existing entry at the Paperclip URL, turning it off
 * when the key is cleared, the key check, the routes, and Pi resolving the
 * reference into the header it actually sends.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { readGlobalMcpServers, testMcpServer, writeGlobalMcpServers } from "../src/agent/mcp.ts";
import {
  PAPERCLIP_MCP_URL,
  connectPaperclipKey,
  disconnectPaperclipKey,
  paperclipConnectorState,
  validatePaperclipApiKey,
} from "../src/agent/paperclip.ts";
import {
  setCredentialEnvPathForTests,
  setPaperclipKeyValidatorForTests,
} from "../src/api/credentials.ts";
import { buildApp } from "../src/index.ts";

const KEY = "gxl_test_key_0123456789";
const REFERENCE = "${PAPERCLIP_API_KEY}";
const original = process.env.PAPERCLIP_API_KEY;
const mcpFile = () => path.join(getAgentDir(), "mcp.json");
const envFile = () => path.join(PROJECTS_ROOT, "paperclip.env");

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(mcpFile(), { force: true });
  delete process.env.PAPERCLIP_API_KEY;
  setCredentialEnvPathForTests(envFile());
});

afterEach(() => {
  setPaperclipKeyValidatorForTests(null);
  setCredentialEnvPathForTests(null);
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.rmSync(mcpFile(), { force: true });
  if (original === undefined) delete process.env.PAPERCLIP_API_KEY;
  else process.env.PAPERCLIP_API_KEY = original;
});

describe("Paperclip connector", () => {
  it("adds a global entry that refers to the key by name, and turns it off without deleting it", () => {
    expect(paperclipConnectorState()).toMatchObject({ keySet: false, name: null, usesKey: false, enabled: false });
    expect(connectPaperclipKey()).toEqual({ name: "paperclip", replaced: false });
    const entry = readGlobalMcpServers().paperclip;
    expect(entry).toMatchObject({ url: PAPERCLIP_MCP_URL, headers: { "X-API-Key": REFERENCE } });
    expect(entry.description).toMatch(/Paperclip/);
    expect(paperclipConnectorState()).toMatchObject({ name: "paperclip", usesKey: true, enabled: true });

    expect(disconnectPaperclipKey()).toEqual({ name: "paperclip" });
    expect(readGlobalMcpServers().paperclip).toEqual({ ...entry, enabled: false });
    expect(disconnectPaperclipKey()).toEqual({ name: null });
    // A later key turns the same entry back on.
    expect(connectPaperclipKey()).toEqual({ name: "paperclip", replaced: true });
    expect(readGlobalMcpServers().paperclip).toEqual(entry);
  });

  it("takes over an entry at the Paperclip URL, keeping its settings but not its credential", () => {
    writeGlobalMcpServers({
      papers: {
        url: `${PAPERCLIP_MCP_URL}/`,
        oauth: { clientId: "x" },
        headers: { "x-api-key": "gxl_literal", Authorization: "Bearer old", "X-Trace": "1" },
        exposure: "direct",
        description: "mine",
        enabled: false,
      },
      other: { url: "https://elsewhere.example/mcp" },
    });
    expect(paperclipConnectorState()).toMatchObject({ name: "papers", usesKey: false, enabled: false });
    expect(connectPaperclipKey()).toEqual({ name: "papers", replaced: true });
    const servers = readGlobalMcpServers();
    expect(servers.papers).toEqual({
      url: `${PAPERCLIP_MCP_URL}/`,
      exposure: "direct",
      description: "mine",
      headers: { "X-Trace": "1", "X-API-Key": REFERENCE },
    });
    expect(servers.other).toEqual({ url: "https://elsewhere.example/mcp" });
  });

  it("leaves an OAuth entry alone when the key is cleared, and picks a free name", () => {
    writeGlobalMcpServers({ paperclip: { url: "https://elsewhere.example/mcp" } });
    expect(connectPaperclipKey()).toEqual({ name: "paperclip-mcp", replaced: false });

    writeGlobalMcpServers({ paperclip: { url: PAPERCLIP_MCP_URL } });
    expect(disconnectPaperclipKey()).toEqual({ name: null });
    expect(readGlobalMcpServers().paperclip).toEqual({ url: PAPERCLIP_MCP_URL });
  });

  it("refuses to rewrite a malformed mcp.json", () => {
    fs.mkdirSync(path.dirname(mcpFile()), { recursive: true });
    fs.writeFileSync(mcpFile(), "{ not json");
    expect(() => connectPaperclipKey()).toThrow(/not valid JSON/);
    expect(paperclipConnectorState().error).toMatch(/not valid JSON/);
    expect(fs.readFileSync(mcpFile(), "utf-8")).toBe("{ not json");
  });
});

describe("Paperclip key check", () => {
  const respond = (status: number) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));

  it("accepts a key Paperclip authenticates and refuses one it rejects", async () => {
    respond(404);
    await expect(validatePaperclipApiKey(KEY)).resolves.toBeUndefined();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://paperclip.gxl.ai/api/v1/documents/kady-key-check");
    expect(init.headers).toMatchObject({ "X-API-Key": KEY });
    respond(401);
    await expect(validatePaperclipApiKey(KEY)).rejects.toThrow(/rejected this API key/);
    respond(503);
    await expect(validatePaperclipApiKey(KEY)).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(validatePaperclipApiKey(KEY)).rejects.toThrow(/Could not reach Paperclip/);
  });
});

describe("Paperclip routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    ensureProjectExists("pc");
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });
  const headers = { "x-project-id": "pc", "content-type": "application/json" };
  const put = (paperclipApiKey: string | null) =>
    app.inject({ method: "PUT", url: "/credentials", headers, payload: { paperclipApiKey } });

  it("saving a checked key adds the connector, clearing it turns the connector off", async () => {
    const checked: string[] = [];
    setPaperclipKeyValidatorForTests(async (key) => {
      checked.push(key);
    });
    let res = await put(`  ${KEY}  `);
    expect(res.statusCode).toBe(200);
    expect(res.json().paperclip).toMatchObject({ set: true });
    expect(checked).toEqual([KEY]);
    expect(process.env.PAPERCLIP_API_KEY).toBe(KEY);
    expect(fs.readFileSync(envFile(), "utf-8")).toContain(`PAPERCLIP_API_KEY=${KEY}`);
    // The key lives only in .env; mcp.json holds the reference.
    expect(fs.readFileSync(mcpFile(), "utf-8")).not.toContain(KEY);
    res = await app.inject({ method: "GET", url: "/mcp/paperclip", headers });
    expect(res.json()).toMatchObject({ keySet: true, name: "paperclip", usesKey: true, enabled: true });

    res = await put(null);
    expect(res.statusCode).toBe(200);
    expect(res.json().paperclip).toEqual({ set: false, masked: null });
    expect(checked).toEqual([KEY]);
    res = await app.inject({ method: "GET", url: "/mcp/paperclip", headers });
    expect(res.json()).toMatchObject({ keySet: false, name: "paperclip", enabled: false });
  });

  it("does not save a key Paperclip rejects", async () => {
    setPaperclipKeyValidatorForTests(async () => {
      throw new Error("Paperclip rejected this API key.");
    });
    const res = await put(KEY);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/rejected/);
    expect(process.env.PAPERCLIP_API_KEY).toBeUndefined();
    expect(fs.existsSync(mcpFile())).toBe(false);
  });

  it("turns the connector on for a key set outside Settings, and only with a key", async () => {
    let res = await app.inject({ method: "POST", url: "/mcp/paperclip", headers: { "x-project-id": "pc" } });
    expect(res.statusCode).toBe(409);
    process.env.PAPERCLIP_API_KEY = KEY;
    res = await app.inject({ method: "POST", url: "/mcp/paperclip", headers: { "x-project-id": "pc" } });
    expect(res.json()).toEqual({ ok: true, name: "paperclip", replaced: false });
    // Pi accepts the entry as written.
    res = await app.inject({ method: "GET", url: "/mcp?scope=global", headers });
    const { paperclip } = res.json().mcpServers;
    res = await app.inject({ method: "PUT", url: "/mcp?scope=global", headers, payload: { mcpServers: { paperclip } } });
    expect(res.statusCode).toBe(200);
  });
});

describe("Pi resolves the key reference", () => {
  it("sends PAPERCLIP_API_KEY from the environment as the X-API-Key header", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers["x-api-key"] as string | undefined);
      res.writeHead(500, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      process.env.PAPERCLIP_API_KEY = KEY;
      const { port } = server.address() as AddressInfo;
      const config = { url: `http://127.0.0.1:${port}/mcp`, headers: { "X-API-Key": REFERENCE } };
      await testMcpServer("paperclip", config, ensureProjectExists("pr"));
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set([KEY]));
    } finally {
      server.close();
    }
  }, 60_000);
});
