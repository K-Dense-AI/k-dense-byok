import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";

const app = await buildApp();
const target = () => path.join(resolvePaths("default").sandbox, "preview.txt");
const get = (etag?: string) => app.inject({ method: "GET", url: "/sandbox/file?path=preview.txt", headers: { "x-project-id": "default", ...(etag ? { "if-none-match": etag } : {}) } });
beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); ensureProjectExists("default"); });
afterAll(async () => { await app.close(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });
describe("conditional file previews", () => {
  it("bounds the actual read when an external writer grows a file after stat", async () => {
    fs.writeFileSync(target(), "small");
    const open = fs.promises.open;
    const spy = vi.spyOn(fs.promises, "open").mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const before = await stat({ bigint: true });
        fs.appendFileSync(target(), Buffer.alloc(600_000));
        return before;
      });
      return handle;
    });
    try { expect((await get()).statusCode).toBe(413); }
    finally { spy.mockRestore(); }
  });
  it("accepts the exact preview limit and rejects directories", async () => {
    fs.writeFileSync(target(), "a".repeat(512_000));
    expect((await get()).body).toHaveLength(512_000);
    fs.rmSync(target());
    fs.mkdirSync(target());
    expect((await get()).statusCode).toBe(404);
  });
  it("returns 304 without a body when unchanged, and invalidates for same-size edits and replacements", async () => {
    fs.writeFileSync(target(), "one");
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("one");
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const etag = String(first.headers.etag);
    const unchanged = await get(etag);
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
    const times = fs.statSync(target());
    fs.writeFileSync(target(), "two");
    fs.utimesSync(target(), times.atime, times.mtime);
    const changed = await get(etag);
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe("two");
    fs.writeFileSync(target() + ".tmp", "new");
    fs.renameSync(target() + ".tmp", target());
    expect((await get(String(changed.headers.etag))).body).toBe("new");
  });
  it("does not let an old validator hide missing or oversized files", async () => {
    fs.writeFileSync(target(), "one");
    const etag = String((await get()).headers.etag);
    fs.writeFileSync(target(), Buffer.alloc(512001));
    expect((await get(etag)).statusCode).toBe(413);
    fs.rmSync(target());
    expect((await get(etag)).statusCode).toBe(404);
  });
});
