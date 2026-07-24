/**
 * Request scoping for an unknown project id (a stale header from a deleted or
 * renamed project). Reads may degrade to the default project, but a write that
 * silently lands there moves a chat, an upload or a spend record into a
 * workspace the caller never asked for.
 */
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { createProject, getProject, listProjects } from "../src/projects.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("unknown project scope", () => {
  it("404s a mutation instead of writing into the default project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-project-id": "deleted-study", "content-type": "application/json" },
      payload: { name: "Should not be created" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ reason: "unknown_project" });
    expect(listProjects()).toEqual([]);
  });

  it("serves a read from the default project and flags the fallback", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { "x-project-id": "deleted-study" },
    });
    expect(res.statusCode).toBe(200);
    // The client needs to notice and re-sync rather than trust the response.
    expect(res.headers["x-project-fallback"]).toBe("deleted-study");
    // Falling back must not resurrect the project the header named.
    expect(getProject("deleted-study")).toBeNull();
    expect(getProject(DEFAULT_PROJECT_ID)).not.toBeNull();
  });

  it("leaves a known project's mutations alone", async () => {
    const p = createProject({ name: "Live study", projectId: "live-study" });
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${p.id}`,
      headers: { "x-project-id": p.id, "content-type": "application/json" },
      payload: { description: "still here" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-project-fallback"]).toBeUndefined();
    expect(getProject(p.id)?.description).toBe("still here");
  });
});
