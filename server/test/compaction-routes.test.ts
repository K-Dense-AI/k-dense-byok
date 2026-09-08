/**
 * Manual compaction (POST /sessions/:id/compact) and per-project compaction
 * settings (GET/PUT /projects/:id/compaction). The registry is mocked; the
 * fake session's compact() bumps its own stats so the ledger delta is real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const fakeSessions = new Map<string, FakeSession>();

class FakeSession {
  sessionId = "c1";
  isStreaming = false;
  state: { errorMessage?: string } = {};
  model = { id: "fake-model", provider: "openrouter" };
  messages: unknown[] = [];
  cost = 0;
  compactCalls: (string | undefined)[] = [];
  failCompact = false;
  subscribe(): () => void {
    return () => {};
  }
  getContextUsage() {
    return { tokens: null, contextWindow: 200_000, percent: null };
  }
  getSessionStats() {
    return { cost: this.cost, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  }
  async compact(instructions?: string) {
    this.compactCalls.push(instructions);
    if (this.failCompact) throw new Error("summary model unavailable");
    this.cost += 0.004;
    return { summary: "…", firstKeptEntryId: "e9", tokensBefore: 120_000, estimatedTokensAfter: 9_000 };
  }
  clearQueue() {
    return { steering: [], followUp: [] };
  }
  async abort() {}
}

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({
    checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })),
    login: vi.fn(),
    logout: vi.fn(),
    listCredentials: vi.fn(async () => []),
    getAvailable: vi.fn(async () => []),
    getProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(),
    removeRuntimeApiKey: vi.fn(),
  })),
  getModelRegistry: vi.fn(() => ({ find: () => null })),
  createSession: vi.fn(),
  getSession: vi.fn(async (_projectId: string, _paths: unknown, id: string) => fakeSessions.get(id) ?? null),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
  setSessionObserver: vi.fn(),
  abortProjectSessions: vi.fn(async () => {}),
  disposeProjectSessions: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { claimRun } from "../src/agent/run-pipeline.ts";

const app = await buildApp();

beforeEach(() => {
  fakeSessions.clear();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

const headers = (projectId = "default") => ({
  "x-project-id": projectId,
  "content-type": "application/json",
});
const costRows = (projectId: string, sessionId: string) => {
  const file = path.join(resolvePaths(projectId).sandbox, ".kady", "runs", sessionId, "costs.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

describe("POST /sessions/:id/compact", () => {
  it("compacts an idle session, ledgers the summary cost and returns the usage state", async () => {
    const project = createProject({ name: "Compact" });
    const s = new FakeSession();
    fakeSessions.set("c1", s);
    const res = await app.inject({
      method: "POST",
      url: "/sessions/c1/compact",
      headers: headers(project.id),
      payload: { instructions: "keep the QC thresholds" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      tokensBefore: 120_000,
      estimatedTokensAfter: 9_000,
      costUsd: 0.004,
      billingMode: "payg",
      contextUsage: { tokens: null, contextWindow: 200_000 },
    });
    expect(s.compactCalls).toEqual(["keep the QC thresholds"]);
    const rows = costRows(project.id, "c1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "agent", costUsd: 0.004 });
  });

  it("409s while streaming or claimed, 404s for unknown sessions, 502s on failure", async () => {
    const s = new FakeSession();
    s.isStreaming = true;
    fakeSessions.set("c1", s);
    let res = await app.inject({ method: "POST", url: "/sessions/c1/compact", headers: headers(), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "streaming" });

    s.isStreaming = false;
    const claim = claimRun("default", "c1")!;
    res = await app.inject({ method: "POST", url: "/sessions/c1/compact", headers: headers(), payload: {} });
    expect(res.statusCode).toBe(409);
    claim.release();

    res = await app.inject({ method: "POST", url: "/sessions/nope/compact", headers: headers(), payload: {} });
    expect(res.statusCode).toBe(404);

    s.failCompact = true;
    res = await app.inject({ method: "POST", url: "/sessions/c1/compact", headers: headers(), payload: {} });
    expect(res.statusCode).toBe(502);
    expect(costRows("default", "c1")).toHaveLength(0);
  });

  it("402s when the project cap is reached", async () => {
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({ sessionId: "x", projectId: p.id, model: "m", before: zero, after: { ...zero, costUsd: 0.02 } });
    fakeSessions.set("c1", new FakeSession());
    const res = await app.inject({ method: "POST", url: "/sessions/c1/compact", headers: headers(p.id), payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ reason: "budget" });
  });
});

describe("project compaction settings", () => {
  it("returns Pi's defaults with bounds when nothing is configured", async () => {
    const p = createProject({ name: "Defaults" });
    const res = await app.inject({ method: "GET", url: `/projects/${p.id}/compaction`, headers: headers(p.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      bounds: {
        reserveTokens: { min: 4_000, max: 64_000 },
        keepRecentTokens: { min: 5_000, max: 200_000 },
      },
    });
  });

  it("writes only the compaction keys, preserving the rest of settings.json", async () => {
    const p = createProject({ name: "Writes" });
    const file = path.join(resolvePaths(p.id).sandbox, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ packages: ["/x/pi-web-access"], subagents: { forceTopLevelAsync: true }, compaction: { enabled: true } }, null, 2));
    const res = await app.inject({
      method: "PUT",
      url: `/projects/${p.id}/compaction`,
      headers: headers(p.id),
      payload: { keepRecentTokens: 40_000, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, reserveTokens: 16_384, keepRecentTokens: 40_000 });
    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(written).toEqual({
      packages: ["/x/pi-web-access"],
      subagents: { forceTopLevelAsync: true },
      compaction: { enabled: false, keepRecentTokens: 40_000 },
    });
  });

  it("400s out-of-bounds values and 409s a malformed settings file", async () => {
    const p = createProject({ name: "Bounds" });
    let res = await app.inject({ method: "PUT", url: `/projects/${p.id}/compaction`, headers: headers(p.id), payload: { reserveTokens: 100 } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PUT", url: `/projects/${p.id}/compaction`, headers: headers(p.id), payload: { keepRecentTokens: 1.5 } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PUT", url: `/projects/${p.id}/compaction`, headers: headers(p.id), payload: { enabled: "yes" } });
    expect(res.statusCode).toBe(400);

    const file = path.join(resolvePaths(p.id).sandbox, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    res = await app.inject({ method: "PUT", url: `/projects/${p.id}/compaction`, headers: headers(p.id), payload: { reserveTokens: 8_000 } });
    expect(res.statusCode).toBe(409);
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
    // Reads degrade to defaults rather than failing.
    res = await app.inject({ method: "GET", url: `/projects/${p.id}/compaction`, headers: headers(p.id) });
    expect(res.json()).toMatchObject({ reserveTokens: 16_384 });
  });
});
