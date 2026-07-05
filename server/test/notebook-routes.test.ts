/**
 * HTTP-level test for the notebook read route. Scoping mirrors
 * steer-abort.test.ts: build the real app (its onRequest hook resolves the
 * project from the X-Project-Id header into the AsyncLocalStorage context
 * that currentProjectId() reads) rather than hand-rolling a scope shim.
 */
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
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
