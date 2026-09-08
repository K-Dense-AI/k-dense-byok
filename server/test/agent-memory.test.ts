/**
 * Per-agent persistent memory: frontmatter round-trip, restore-defaults
 * preservation, and the memory file routes.
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
import {
  agentMemoryFile,
  listAgents,
  parseAgentMarkdown,
  parseAgentMemory,
  restoreDefaultAgents,
  seedAgentFiles,
  serializeAgentMarkdown,
  writeProjectAgent,
} from "../src/agent/agent-files.ts";

const app = await buildApp();
let projectId: string;
const h = (pid: string) => ({ "x-project-id": pid, "content-type": "application/json" });
const hg = (pid: string) => ({ "x-project-id": pid });

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "agent-memory"), { recursive: true, force: true });
  projectId = createProject({ name: "Memory" }).id;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("agent memory frontmatter", () => {
  it("parses block-ish and inline forms and writes the inline form", () => {
    expect(parseAgentMemory("{ scope: project, path: data-validator }")).toEqual({ scope: "project", path: "data-validator" });
    expect(parseAgentMemory('{ scope: "user", path: "reviewer" }')).toEqual({ scope: "user", path: "reviewer" });
    expect(parseAgentMemory("{ scope: galaxy, path: x }")).toBeUndefined();
    expect(parseAgentMemory("{ scope: project, path: ../escape }")).toBeUndefined();
    const md = serializeAgentMarkdown({
      name: "data-validator",
      description: "checks data",
      memory: { scope: "project", path: "data-validator" },
      systemPrompt: "Validate.",
    });
    expect(md).toContain("memory: { scope: project, path: data-validator }");
    const parsed = parseAgentMarkdown(md, "data-validator", "project");
    expect(parsed.memory).toEqual({ scope: "project", path: "data-validator" });
    expect(parsed.extra).toBeUndefined();
  });

  it("survives restore-defaults on a seeded specialist", () => {
    const paths = resolvePaths(projectId);
    seedAgentFiles(paths);
    const seeded = listAgents(paths).find((a) => a.name === "data-validator")!;
    writeProjectAgent(paths, "data-validator", { ...seeded, memory: { scope: "project", path: "data-validator" } });
    restoreDefaultAgents(paths);
    const restored = listAgents(paths).find((a) => a.name === "data-validator")!;
    expect(restored.memory).toEqual({ scope: "project", path: "data-validator" });
    expect(restored.systemPrompt).toBe(seeded.systemPrompt);
    expect(listAgents(paths).find((a) => a.name === "code-reviewer")!.memory).toBeUndefined();
  });
});

describe("agent memory routes", () => {
  it("saves memory settings through PUT /agents/:name and reads/edits/clears MEMORY.md", async () => {
    const paths = resolvePaths(projectId);
    seedAgentFiles(paths);
    let res = await app.inject({ method: "GET", url: "/agents/data-validator/memory", headers: hg(projectId) });
    expect(res.statusCode).toBe(404);

    const agent = listAgents(paths).find((a) => a.name === "data-validator")!;
    res = await app.inject({
      method: "PUT",
      url: "/agents/data-validator",
      headers: h(projectId),
      payload: { ...agent, memory: { scope: "project", path: "data-validator" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.memory).toEqual({ scope: "project", path: "data-validator" });

    res = await app.inject({ method: "GET", url: "/agents/data-validator/memory", headers: hg(projectId) });
    expect(res.json()).toEqual({
      memory: { scope: "project", path: "data-validator" },
      exists: false,
      content: "",
      limits: { lines: 200, bytes: 16 * 1024 },
    });

    res = await app.inject({ method: "PUT", url: "/agents/data-validator/memory", headers: h(projectId), payload: { content: "- 2026-09-08: sample IDs are 1-based\n" } });
    expect(res.statusCode).toBe(200);
    const file = agentMemoryFile(paths, { scope: "project", path: "data-validator" });
    expect(file).toBe(path.join(paths.sandbox, ".pi", "agent-memory", "data-validator", "MEMORY.md"));
    expect(fs.readFileSync(file, "utf-8")).toContain("1-based");
    res = await app.inject({ method: "GET", url: "/agents/data-validator/memory", headers: hg(projectId) });
    expect(res.json()).toMatchObject({ exists: true, content: expect.stringContaining("1-based") });

    res = await app.inject({ method: "PUT", url: "/agents/data-validator/memory", headers: h(projectId), payload: { content: 5 } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "DELETE", url: "/agents/data-validator/memory", headers: hg(projectId) });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(file)).toBe(false);

    // Bad memory settings are rejected; user scope resolves under the agent dir.
    res = await app.inject({ method: "PUT", url: "/agents/data-validator", headers: h(projectId), payload: { ...agent, memory: { scope: "galaxy", path: "x" } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PUT", url: "/agents/data-validator", headers: h(projectId), payload: { ...agent, memory: { scope: "user", path: "Bad Path" } } });
    expect(res.statusCode).toBe(400);
    expect(agentMemoryFile(paths, { scope: "user", path: "shared" })).toBe(path.join(KADY_PI_AGENT_DIR, "agent-memory", "shared", "MEMORY.md"));
  });
});
