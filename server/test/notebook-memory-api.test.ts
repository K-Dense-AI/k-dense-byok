import fs from "node:fs";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
const app = await buildApp();
beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); createProject({ name: "A", projectId: "a" }); createProject({ name: "B", projectId: "b" }); });
afterAll(async () => { await app.close(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });
const add = (project = "a") => appendNotebookEntry("s", { id: "e", type: "decision", title: `Harmony in ${project}`, body: "Reject the confounded model", role: "agent", timestamp: 1000 }, project);

describe("research memory API", () => {
  it("searches, reads and supplies the same bounded tool envelope", async () => {
    add();
    const search = await app.inject({ method: "POST", url: "/projects/a/notebook/memory/search", headers: { "x-project-id": "a" }, payload: { query: "Harmony" } });
    expect(search.statusCode, search.body).toBe(200); expect(search.headers["cache-control"]).toBe("no-store");
    const hit = search.json().hits[0];
    const read = await app.inject({ method: "GET", url: hit.sourceUri }); // source URI carries its project scope
    expect(read.statusCode, read.body).toBe(200); expect(read.json().entry.title).toBe("Harmony in a");
    const tool = await app.inject({ method: "POST", url: "/projects/a/notebook/memory/tool", headers: { "x-project-id": "a" }, payload: { action: "read", source: hit.source, expectedDigest: hit.digest, projectId: "b" } });
    expect(tool.statusCode).toBe(200);
    expect(JSON.parse(tool.json().content[0].text).projectId).toBe("a");
    expect(tool.json().details.memory).toBe(true);
  });
  it("does not fall back or let body/header/path select a different project", async () => {
    add("a"); add("b");
    const mismatch = await app.inject({ method: "POST", url: "/projects/a/notebook/memory/search", headers: { "x-project-id": "b" }, payload: { query: "Harmony" } });
    expect(mismatch.statusCode).toBe(404);
    const ghost = await app.inject({ method: "GET", url: `/projects/no-such/notebook/memory/record?project=no-such&source=${encodeURIComponent(JSON.stringify({ kind: "notebook", sessionId: "s", entryId: "e" }))}` });
    expect(ghost.statusCode).toBe(404);
  });
  it("reports invalid and missing sources explicitly", async () => {
    const bad = await app.inject({ method: "GET", url: "/projects/a/notebook/memory/record?source=not-json", headers: { "x-project-id": "a" } });
    expect(bad.statusCode).toBe(400);
    const invalid = await app.inject({ method: "POST", url: "/projects/a/notebook/memory/tool", headers: { "x-project-id": "a" }, payload: { action: "write", query: "x" } });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/projects/a/notebook/memory/tool", headers: { "x-project-id": "a" }, payload: { action: "read", source: { kind: "notebook", sessionId: "s", entryId: "absent" } } });
    expect(missing.statusCode).toBe(404);
  });
});
