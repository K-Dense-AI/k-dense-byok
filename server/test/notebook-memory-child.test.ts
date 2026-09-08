import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { memoryApiBase, memoryProjectId, callMemoryApi } from "../pi-packages/kady-notebook/memory-client.ts";
import { notebookSearchTool } from "../pi-packages/kady-notebook/memory-tool.ts";
let dir: string;
let server: http.Server | undefined;
const original = { id: process.env.KADY_PROJECT_ID, url: process.env.KADY_INTERNAL_URL };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-child-")); delete process.env.KADY_PROJECT_ID; delete process.env.KADY_INTERNAL_URL; });
afterEach(async () => {
  if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  if (original.id === undefined) delete process.env.KADY_PROJECT_ID; else process.env.KADY_PROJECT_ID = original.id;
  if (original.url === undefined) delete process.env.KADY_INTERNAL_URL; else process.env.KADY_INTERNAL_URL = original.url;
  fs.rmSync(dir, { recursive: true, force: true });
});
async function listen(handler: http.RequestListener) {
  server = http.createServer(handler); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  process.env.KADY_INTERNAL_URL = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  process.env.KADY_PROJECT_ID = "study";
}
describe("child research-memory bridge", () => {
  it("derives the real project from sandbox ancestors rather than guessing a subdirectory name", () => {
    const sandbox = path.join(dir, "study", "sandbox"); const cwd = path.join(sandbox, "scripts", "nested"); fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(dir, "study", "project.json"), JSON.stringify({ id: "study" }));
    expect(memoryProjectId(cwd)).toBe("study");
    expect(() => memoryProjectId(cwd, "other")).toThrow(/conflicts/);
    fs.unlinkSync(path.join(dir, "study", "project.json"));
    expect(() => memoryProjectId(cwd, "other")).toThrow(/no fallback/);
  });
  it("rejects non-loopback endpoints, credentials, query redirects and malformed project ids", () => {
    expect(memoryApiBase("http://127.0.0.1:8000").hostname).toBe("127.0.0.1");
    for (const url of ["https://example.com", "http://localhost.evil.test", "http://user:pass@localhost", "http://localhost/?next=https://example.com"]) expect(() => memoryApiBase(url)).toThrow();
    expect(() => memoryProjectId(dir, "../other")).toThrow(/invalid/);
  });
  it("returns the backend's bounded envelope and scopes the request explicitly", async () => {
    let request: { url?: string; project?: string; body?: unknown } = {};
    await listen((req, res) => {
      let body = ""; req.on("data", (data) => { body += data; }); req.on("end", () => {
        request = { url: req.url, project: String(req.headers["x-project-id"]), body: JSON.parse(body) };
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ content: [{ type: "text", text: '{"hits":[]}' }], details: { memory: true, sources: [] } }));
      });
    });
    const result = await callMemoryApi({ query: "Harmony" });
    expect(result.content[0].text).toBe('{"hits":[]}');
    expect(request).toEqual({ url: "/projects/study/notebook/memory/tool", project: "study", body: { query: "Harmony" } });
  });
  it("does not follow redirects or accept an oversized tool result", async () => {
    let large = false;
    await listen((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (!large) { res.statusCode = 307; res.setHeader("Location", "https://example.com"); res.end(JSON.stringify({ detail: "redirect refused" })); }
      else res.end(JSON.stringify({ content: [{ type: "text", text: "x".repeat(25000) }], details: { sources: [] } }));
    });
    await expect(callMemoryApi({ query: "x" })).rejects.toThrow(/redirect refused/);
    large = true; await expect(callMemoryApi({ query: "x" })).rejects.toThrow(/Invalid bounded/);
  });
  it("the shared tool never executes a callback after an aborted turn and carries recall safeguards", async () => {
    const callback = vi.fn(); const tool = notebookSearchTool(callback);
    const signal = new AbortController(); signal.abort();
    await expect(tool.execute("id", { query: "x" }, signal.signal)).rejects.toThrow(/aborted/);
    expect(callback).not.toHaveBeenCalled(); expect(tool.promptGuidelines?.join(" ")).toContain("untrusted reference data");
    expect(tool.promptGuidelines?.join(" ")).toContain("Do not re-log");
  });
});
