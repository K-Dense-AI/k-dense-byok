/**
 * Prompt-template management: seeding, scopes/shadowing, CRUD validation, and
 * the skill "user-invoked only" toggle.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({ checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })) })),
  getModelRegistry: vi.fn(() => ({ find: () => null })),
  createSession: vi.fn(),
  getSession: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
  setSessionObserver: vi.fn(),
  abortProjectSessions: vi.fn(async () => {}),
  disposeProjectSessions: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { KADY_PI_AGENT_DIR, PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { expandableTemplates, SEEDED_TEMPLATES } from "../src/agent/prompts.ts";
import { projectSkillRoot } from "../src/agent/skills.ts";

const app = await buildApp();
let projectId: string;
const h = (pid: string) => ({ "x-project-id": pid, "content-type": "application/json" });
// Fastify rejects a JSON content-type with an empty body on DELETE.
const hd = (pid: string) => ({ "x-project-id": pid });

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "prompts"), { recursive: true, force: true });
  projectId = createProject({ name: "Prompts" }).id;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "prompts"), { recursive: true, force: true });
});

describe("prompt templates", () => {
  it("seeds the scientific templates once and lists them merged with global ones", async () => {
    let res = await app.inject({ method: "GET", url: "/prompts", headers: h(projectId) });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(SEEDED_TEMPLATES.map((t) => t.name).sort());
    const qc = (res.json() as Array<{ name: string; argumentHint?: string; description: string; scope: string; seeded?: boolean }>).find((t) => t.name === "qc")!;
    expect(qc).toMatchObject({ scope: "project", argumentHint: "<file>", seeded: true });
    expect(qc.description).toMatch(/Quality-control/);

    // Deleting a seeded template sticks across later listings (marker-gated seeding).
    res = await app.inject({ method: "DELETE", url: "/prompts/qc?scope=project", headers: hd(projectId) });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/prompts", headers: h(projectId) });
    expect((res.json() as { name: string }[]).map((t) => t.name)).not.toContain("qc");

    // A global template appears merged; a project one with the same name shadows it.
    res = await app.inject({ method: "POST", url: "/prompts?scope=global", headers: h(projectId), payload: { name: "lit-scan", description: "Literature scan", argumentHint: "<topic>", content: "Search the literature on $1." } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/prompts", headers: h(projectId) });
    expect((res.json() as { name: string; scope: string }[]).find((t) => t.name === "lit-scan")).toMatchObject({ scope: "global" });
    res = await app.inject({ method: "POST", url: "/prompts?scope=project", headers: h(projectId), payload: { name: "lit-scan", content: "Project-specific scan of $1." } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/prompts?scope=global", headers: h(projectId) });
    expect((res.json() as { name: string; shadowed?: boolean }[]).find((t) => t.name === "lit-scan")?.shadowed).toBe(true);
    expect(expandableTemplates(resolvePaths(projectId)).find((t) => t.name === "lit-scan")?.content.trim()).toBe("Project-specific scan of $1.");

    // Restore puts the seeded ones back without touching user templates.
    res = await app.inject({ method: "POST", url: "/prompts/restore-defaults", headers: hd(projectId) });
    expect(res.json()).toEqual({ restored: SEEDED_TEMPLATES.length });
    res = await app.inject({ method: "GET", url: "/prompts?scope=project", headers: h(projectId) });
    const restored = (res.json() as { name: string }[]).map((t) => t.name);
    expect(restored).toContain("qc");
    expect(restored).toContain("lit-scan");
  });

  it("validates names and content, reads and writes source, 404s on unknown", async () => {
    let res = await app.inject({ method: "POST", url: "/prompts", headers: h(projectId), payload: { name: "Bad Name" } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "POST", url: "/prompts", headers: h(projectId), payload: { name: "qc" } });
    expect(res.statusCode).toBe(409);
    res = await app.inject({ method: "GET", url: "/prompts/qc/source", headers: h(projectId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "qc", scope: "project" });
    expect((res.json() as { content: string }).content).toContain("argument-hint: <file>");
    res = await app.inject({ method: "PUT", url: "/prompts/qc/source", headers: h(projectId), payload: { content: "---\ndescription: Custom QC\n---\n\nDo QC on $1.\n" } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/prompts", headers: h(projectId) });
    expect((res.json() as { name: string; description: string }[]).find((t) => t.name === "qc")?.description).toBe("Custom QC");
    res = await app.inject({ method: "PUT", url: "/prompts/qc/source", headers: h(projectId), payload: { content: "   " } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "GET", url: "/prompts/nope/source", headers: h(projectId) });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: "DELETE", url: "/prompts/nope", headers: hd(projectId) });
    expect(res.statusCode).toBe(404);
  });
});

describe("skill model-invocation toggle", () => {
  it("adds/removes disable-model-invocation without touching other frontmatter, and exposes it", async () => {
    const root = projectSkillRoot(resolvePaths(projectId));
    const dir = path.join(root.skillsDir, "lab-protocol");
    fs.mkdirSync(dir, { recursive: true });
    const original = "---\nname: lab-protocol\ndescription: A careful protocol\nlicense: MIT\n---\n\n# Steps\n\n1. do it\n";
    fs.writeFileSync(path.join(dir, "SKILL.md"), original);

    let res = await app.inject({ method: "POST", url: "/skills/lab-protocol/model-invocation", headers: h(projectId), payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disableModelInvocation: true });
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(
      "---\nname: lab-protocol\ndescription: A careful protocol\nlicense: MIT\ndisable-model-invocation: true\n---\n\n# Steps\n\n1. do it\n",
    );
    res = await app.inject({ method: "GET", url: "/skills", headers: h(projectId) });
    expect((res.json() as { name: string; disableModelInvocation: boolean }[]).find((s) => s.name === "lab-protocol")?.disableModelInvocation).toBe(true);

    res = await app.inject({ method: "POST", url: "/skills/lab-protocol/model-invocation", headers: h(projectId), payload: { enabled: true } });
    expect(res.json()).toEqual({ disableModelInvocation: false });
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe(original);

    res = await app.inject({ method: "POST", url: "/skills/lab-protocol/model-invocation", headers: h(projectId), payload: { enabled: "no" } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "POST", url: "/skills/nope/model-invocation", headers: h(projectId), payload: { enabled: false } });
    expect(res.statusCode).toBe(404);
  });
});
