/**
 * HTTP-level test for the notebook read route. Scoping mirrors
 * steer-abort.test.ts: build the real app (its onRequest hook resolves the
 * project from the X-Project-Id header into the AsyncLocalStorage context
 * that currentProjectId() reads) rather than hand-rolling a scope shim.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { appendNotebookEntry, type NotebookEntry } from "../src/agent/notebook-store.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function getNotebook(id: string, projectId = "default") {
  return app.inject({
    method: "GET",
    url: `/sessions/${id}/notebook`,
    headers: { "x-project-id": projectId },
  });
}

const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "tc_1", type: "method", title: "Ran PCA", timestamp: 1, role: "agent", ...over,
});

describe("GET /sessions/:id/notebook", () => {
  it("returns [] for a session with no entries", async () => {
    const res = await getNotebook("empty-sess");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("returns persisted entries", async () => {
    appendNotebookEntry("route-sess", entry({ id: "tc_1" }), "default");
    appendNotebookEntry("route-sess", entry({ id: "tc_2", type: "observation" }), "default");
    const res = await getNotebook("route-sess");
    expect(res.json().entries.map((e: NotebookEntry) => e.id)).toEqual(["tc_1", "tc_2"]);
  });
});

describe("GET /sessions/:id/notebook/export", () => {
  it("returns markdown with format=md and 400 with unsupported format", async () => {
    appendNotebookEntry("route-sess", entry({ id: "tc_1" }), "default");
    const resExport = await app.inject({
      method: "GET",
      url: "/sessions/route-sess/notebook/export?format=md",
      headers: { "x-project-id": "default" },
    });
    expect(resExport.statusCode).toBe(200);
    expect(resExport.headers["content-type"]).toContain("text/markdown");
    expect(resExport.body).toMatch(/# Lab Notebook/);

    const resPdf = await app.inject({
      method: "GET",
      url: "/sessions/route-sess/notebook/export?format=pdf",
      headers: { "x-project-id": "default" },
    });
    expect(resPdf.statusCode).toBe(400);
    expect(resPdf.json().detail).toMatch(/format must be md, json, or zip/);
  });

  it("returns a JSON download with format=json", async () => {
    appendNotebookEntry("route-json", entry({ id: "tc_1" }), "default");
    appendNotebookEntry("route-json", entry({ id: "tc_2", type: "observation" }), "default");
    const res = await app.inject({
      method: "GET",
      url: "/sessions/route-json/notebook/export?format=json",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain('filename="lab-notebook-route-json.json"');
    const body = res.json();
    expect(body.sessionId).toBe("route-json");
    expect(typeof body.projectName).toBe("string");
    expect(body.entries.map((e: NotebookEntry) => e.id)).toEqual(["tc_1", "tc_2"]);
  });

  it("returns a zip archive with format=zip", async () => {
    appendNotebookEntry("route-zip", entry({ id: "tc_1", artifacts: ["figures/f.png"] }), "default");
    const sandbox = resolvePaths("default").sandbox;
    fs.mkdirSync(path.join(sandbox, "figures"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "figures", "f.png"), "PNG", "utf-8");

    const res = await app.inject({
      method: "GET",
      url: "/sessions/route-zip/notebook/export?format=zip",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain('filename="lab-notebook-route-zip.zip"');
    const names = new AdmZip(res.rawPayload).getEntries().map((e) => e.entryName);
    expect(names).toContain("lab-notebook.md");
    expect(names).toContain("artifacts/figures/f.png");
  });
});

describe("notebook annotations", () => {
  const annUrl = "/sessions/ann-sess/notebook/annotations";
  const put = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "PUT", url: annUrl, headers: { "x-project-id": "default", ...headers }, payload });
  const get = () =>
    app.inject({ method: "GET", url: annUrl, headers: { "x-project-id": "default" } });

  it("GET returns an empty envelope with no Last-Modified when absent", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 1, annotations: [] });
    expect(res.headers["last-modified"]).toBeUndefined();
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("PUT persists and round-trips with a Last-Modified header", async () => {
    const ann = { id: "p1", kind: "pin", entryId: "tc_1", createdAt: 123 };
    const res = await put({ version: 1, annotations: [ann] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: "ann-sess", count: 1 });
    expect(res.headers["last-modified"]).toBeDefined();

    const got = await get();
    expect(got.headers["last-modified"]).toBeDefined();
    expect(got.json().annotations).toHaveLength(1);
    expect(got.json().annotations[0]).toMatchObject({ id: "p1", kind: "pin", entryId: "tc_1" });
  });

  it("PUT with a stale If-Unmodified-Since returns 412", async () => {
    await put({ version: 1, annotations: [] }); // create the sidecar first
    const res = await put(
      { version: 1, annotations: [] },
      { "if-unmodified-since": new Date(1000).toUTCString() },
    );
    expect(res.statusCode).toBe(412);
    expect(res.json().detail).toMatch(/re-read and retry/);
  });

  it("PUT with an invalid item returns 400 with a field-scoped message", async () => {
    // A comment with no body violates normalizeNotebookAnnotations.
    const res = await put({ version: 1, annotations: [{ id: "c1", kind: "comment", entryId: "tc_1" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/annotations\[0\]/);
  });
});

describe("POST /sessions/:id/notebook/methods-draft", () => {
  it("returns 400 (methods-draft-failed) when the notebook is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions/no-entries/notebook/methods-draft",
      headers: { "x-project-id": "default" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe("methods-draft-failed");
  });
});

describe("GET /projects/:projectId/notebook", () => {
  it("merges every session's entries into a sorted list with a per-session summary", async () => {
    appendNotebookEntry("sess-1", entry({ id: "a", timestamp: 1 }), "default");
    appendNotebookEntry("sess-2", entry({ id: "b", timestamp: 2 }), "default");
    appendNotebookEntry("sess-1", entry({ id: "c", timestamp: 3 }), "default");

    const res = await app.inject({
      method: "GET",
      url: "/projects/default/notebook",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: NotebookEntry & { sessionId: string }) => [e.id, e.sessionId])).toEqual([
      ["a", "sess-1"],
      ["b", "sess-2"],
      ["c", "sess-1"],
    ]);
    expect(body.sessions).toEqual([
      { sessionId: "sess-1", entryCount: 2, firstTimestamp: 1, lastTimestamp: 3 },
      { sessionId: "sess-2", entryCount: 1, firstTimestamp: 2, lastTimestamp: 2 },
    ]);
  });
});

describe("GET /projects/:projectId/notebook/export", () => {
  const exportProject = (format: string) =>
    app.inject({
      method: "GET",
      url: `/projects/default/notebook/export?format=${format}`,
      headers: { "x-project-id": "default" },
    });

  it("rejects an unsupported format", async () => {
    expect((await exportProject("pdf")).statusCode).toBe(400);
  });

  it("merges every session into one markdown document, grouped by chat", async () => {
    appendNotebookEntry("sess-1", entry({ id: "a", timestamp: 1, title: "From chat one" }), "default");
    appendNotebookEntry("sess-2", entry({ id: "b", timestamp: 2, title: "From chat two" }), "default");

    const res = await exportProject("md");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("lab-notebook-default.md");
    const md = res.body;
    // Both chats present — the whole point of the project-scope route.
    expect(md).toContain("From chat one");
    expect(md).toContain("From chat two");
    expect(md).toContain("**Chats:** 2");
    // Grouped: chat heading at h2, entries demoted to h3.
    expect(md).toContain("## sess-1");
    expect(md).toContain("## sess-2");
    expect(md).toContain("### Method: From chat one");
  });

  it("includes every session's annotation sidecar in the json export", async () => {
    appendNotebookEntry("sess-1", entry({ id: "a", timestamp: 1 }), "default");
    appendNotebookEntry("sess-2", entry({ id: "b", timestamp: 2 }), "default");
    const dir = resolvePaths("default").notebookDir;
    fs.mkdirSync(dir, { recursive: true });
    for (const [sess, entryId] of [["sess-1", "a"], ["sess-2", "b"]]) {
      fs.writeFileSync(
        path.join(dir, `${sess}.annotations.json`),
        JSON.stringify({
          version: 1,
          annotations: [
            { id: `pin-${sess}`, kind: "pin", entryId, createdAt: 10 },
          ],
        }),
      );
    }

    const body = (await exportProject("json")).json();
    expect(body.projectId).toBe("default");
    expect(body.entries.map((e: NotebookEntry) => e.id)).toEqual(["a", "b"]);
    expect(body.annotations.map((a: { id: string }) => a.id).sort()).toEqual([
      "pin-sess-1",
      "pin-sess-2",
    ]);
  });

  it("bundles artifacts from every session into one zip", async () => {
    const sandbox = resolvePaths("default").sandbox;
    fs.mkdirSync(path.join(sandbox, "figures"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "figures", "one.png"), "png-one");
    fs.writeFileSync(path.join(sandbox, "figures", "two.png"), "png-two");
    appendNotebookEntry("sess-1", entry({ id: "a", timestamp: 1, artifacts: ["figures/one.png"] }), "default");
    appendNotebookEntry("sess-2", entry({ id: "b", timestamp: 2, artifacts: ["figures/two.png"] }), "default");

    const res = await exportProject("zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    const names = new AdmZip(res.rawPayload).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual([
      "artifacts/figures/one.png",
      "artifacts/figures/two.png",
      "lab-notebook.md",
    ]);
  });
});
