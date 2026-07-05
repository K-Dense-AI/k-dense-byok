/**
 * HTTP-level tests for the steering side-channel and abort queue restore.
 * The session registry is mocked so no real Pi session (auth, model) is
 * needed; the fake exposes exactly the surface the routes touch.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fakeSessions = new Map<string, FakeSession>();

class FakeSession {
  isStreaming = true;
  steered: string[] = [];
  aborted = false;
  clearQueueCalls = 0;
  /** Called by steer(); lets a test flip isStreaming mid-call. */
  onSteer: (() => void) | null = null;

  async steer(text: string): Promise<void> {
    this.steered.push(text);
    this.onSteer?.();
  }
  getSteeringMessages(): readonly string[] {
    return this.steered;
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const steering = [...this.steered];
    this.steered = [];
    return { steering, followUp: [] };
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

vi.mock("../src/agent/session-registry.ts", () => ({
  getAuthStorage: vi.fn(),
  getModelRegistry: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(async (_projectId: string, _paths: unknown, id: string) =>
    fakeSessions.get(id) ?? null,
  ),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";

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

function steer(id: string, body: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/steer`,
    headers: { "x-project-id": projectId, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });
}

describe("POST /sessions/:id/abort", () => {
  it("clears the queue before aborting and returns the texts", async () => {
    const s = new FakeSession();
    await s.steer("pending steer");
    fakeSessions.set("s1", s);
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: ["pending steer"] });
    expect(s.aborted).toBe(true);
    expect(s.clearQueueCalls).toBe(1);
  });

  it("returns ok with empty restored for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions/nope/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: [] });
  });
});

describe("POST /sessions/:id/steer", () => {
  it("404s for an unknown session", async () => {
    const res = await steer("nope", { message: "hi" });
    expect(res.statusCode).toBe(404);
  });

  it("400s for an empty message", async () => {
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("409s with reason not_streaming when no run is live", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
    expect(s.steered).toEqual([]);
  });

  it("queues the message and returns the pending list", async () => {
    const s = new FakeSession();
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "exclude sample 7" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pending: ["exclude sample 7"] });
    expect(s.steered).toEqual(["exclude sample 7"]);
  });

  it("409s and clears the queue when the run ends while queueing", async () => {
    const s = new FakeSession();
    s.onSteer = () => {
      s.isStreaming = false;
    };
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "too late" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
    // The stale steer must not leak into the next run.
    expect(s.clearQueueCalls).toBe(1);
    expect(s.steered).toEqual([]);
  });

  it("403s with reason budget when the project cap is reached", async () => {
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "s1",
      projectId: p.id,
      model: "m",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "hi" }, p.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "budget" });
  });
});
