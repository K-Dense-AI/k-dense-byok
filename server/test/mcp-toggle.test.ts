import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  disableMcpServer,
  enableMcpServer,
  readMcpConfig,
  readMcpDisabled,
  writeMcpConfig,
} from "../src/agent/mcp.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("connectors enable/disable", () => {
  it("moves a server between mcp.json and mcp-disabled.json, preserving config", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    writeMcpConfig(paths, {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "secret" } },
      gh: { command: "npx", args: ["-y", "server-github"] },
    });

    expect(disableMcpServer(paths, "linear")).toEqual({ ok: true });
    expect(Object.keys(readMcpConfig(paths))).toEqual(["gh"]);
    expect(readMcpDisabled(paths).linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "secret" },
    });

    expect(enableMcpServer(paths, "linear")).toEqual({ ok: true });
    expect(Object.keys(readMcpConfig(paths)).sort()).toEqual(["gh", "linear"]);
    expect(readMcpDisabled(paths)).toEqual({});
  });

  it("404 when the named server is not in the source state", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    expect(disableMcpServer(paths, "ghost")).toMatchObject({ ok: false, status: 404 });
    expect(enableMcpServer(paths, "ghost")).toMatchObject({ ok: false, status: 404 });
  });
});
