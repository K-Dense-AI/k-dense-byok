/**
 * HTTP-level tests for the steering side-channel and abort queue restore.
 * The session registry is mocked so no real Pi session (auth, model) is
 * needed; the fake exposes exactly the surface the routes touch.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fakeSessions = new Map<string, FakeSession>();

class FakeSession {
  sessionId = "s1";
  isStreaming = true;
  steered: string[] = [];
  aborted = false;
  clearQueueCalls = 0;
  calls: string[] = [];
  state: { errorMessage?: string } = {};
  model = { id: "fake-model" };
  promptCalls: { text: string; options: unknown }[] = [];
  /** Called by steer(); lets a test flip isStreaming mid-call. */
  onSteer: (() => void) | null = null;
  private listeners = new Set<(event: any) => void>();
  private promptWait: Promise<void> | null = null;
  private releasePromptWait: (() => void) | null = null;
  private modelWait: Promise<void> | null = null;
  private releaseModelWait: (() => void) | null = null;

  holdPrompt(): void {
    this.promptWait = new Promise<void>((resolve) => {
      this.releasePromptWait = resolve;
    });
  }
  releasePrompt(): void {
    this.releasePromptWait?.();
    this.releasePromptWait = null;
  }
  holdModelSetup(): void {
    this.modelWait = new Promise<void>((resolve) => {
      this.releaseModelWait = resolve;
    });
  }
  releaseModelSetup(): void {
    this.releaseModelWait?.();
    this.releaseModelWait = null;
  }
  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: any): void {
    for (const listener of this.listeners) listener(event);
  }
  async prompt(text: string, options?: unknown): Promise<void> {
    this.calls.push("prompt");
    this.promptCalls.push({ text, options });
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    await this.promptWait;
    this.emit({ type: "agent_end" });
    this.isStreaming = false;
  }
  getContextUsage() {
    return { tokens: 12, contextWindow: 1_000, percent: 1.2 };
  }
  getSessionStats() {
    return {
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, total: 0 },
    };
  }
  getActiveToolNames(): string[] {
    return ["read", "bash"];
  }
  setActiveToolsByName(_names: string[]): void {}
  async setModel(_model: unknown): Promise<void> {
    await this.modelWait;
  }
  setThinkingLevel(_level: unknown): void {}

  async steer(text: string): Promise<void> {
    this.calls.push("steer");
    this.steered.push(text);
    this.onSteer?.();
  }
  getSteeringMessages(): readonly string[] {
    return this.steered;
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.calls.push("clearQueue");
    this.clearQueueCalls += 1;
    const steering = [...this.steered];
    this.steered = [];
    return { steering, followUp: [] };
  }
  async abort(): Promise<void> {
    this.calls.push("abort");
    this.aborted = true;
  }
}

vi.mock("../src/agent/session-registry.ts", () => ({
  getAuthStorage: vi.fn(),
  getModelRegistry: vi.fn(() => ({ find: () => null })),
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
import { runBroker } from "../src/agent/run-broker.ts";

const app = await buildApp();

beforeEach(() => {
  fakeSessions.clear();
  runBroker.clear();
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
    expect(s.calls).toEqual(["steer", "clearQueue", "abort"]);
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

describe("POST /sessions/:id/run image validation", () => {
  function run(id: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/sessions/${id}/run`,
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: body as Record<string, unknown>,
    });
  }

  it("400s for images outside the vision allowlist before any streaming", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await run("s1", {
      message: "what is this?",
      images: [{ data: "aGVsbG8=", mimeType: "image/tiff" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("image/tiff");
  });

  it("400s for malformed image entries", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await run("s1", { message: "hi", images: [{ mimeType: "image/png" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("base64");
  });
});

function sseFrames(body: string): Record<string, unknown>[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
}

describe("persistent run routes", () => {
  it("reports running state and replays sequenced events through completion", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    fakeSessions.set("s1", session);

    const postRun = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "persistent prompt" },
    });

    let running: any;
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/sessions/s1/run/state",
        headers: { "x-project-id": "default" },
      });
      running = response.json();
      expect(running.status).toBe("running");
    });
    expect(running.run).toMatchObject({
      prompt: "persistent prompt",
      images: [],
      baseline: {
        messages: [],
        contextUsage: { tokens: 12, contextWindow: 1_000, percent: 1.2 },
      },
    });
    expect(running.run.frames.map((frame: any) => frame.seq)).toEqual([1, 2, 3]);
    expect(running.run.frames.map((frame: any) => frame.type)).toEqual([
      "run_start",
      "context_usage",
      "agent_start",
    ]);

    const replay = app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=1",
      headers: { "x-project-id": "default" },
    });
    session.releasePrompt();

    const [postResponse, replayResponse] = await Promise.all([postRun, replay]);
    expect(postResponse.statusCode).toBe(200);
    expect(replayResponse.statusCode).toBe(200);

    const postFrames = sseFrames(postResponse.body);
    expect(postFrames.at(-1)?.type).toBe("done");
    expect(postFrames.map((frame) => frame.seq)).toEqual(
      postFrames.map((_frame, index) => index + 1),
    );
    const replayFrames = sseFrames(replayResponse.body);
    expect(replayFrames[0]?.seq).toBe(2);
    expect(replayFrames.at(-1)?.type).toBe("done");

    const completed = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/state",
      headers: { "x-project-id": "default" },
    });
    expect(completed.json()).toMatchObject({
      status: "complete",
      run: { prompt: "persistent prompt", lastSeq: postFrames.length },
    });
  });

  it("validates event cursors and 404s when no run is retained", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=-1",
      headers: { "x-project-id": "default" },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=0",
      headers: { "x-project-id": "default" },
    });
    expect(missing.statusCode).toBe(404);
    const state = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/state",
      headers: { "x-project-id": "default" },
    });
    expect(state.json()).toEqual({ status: "none" });
  });

  it("keeps explicit abort authoritative during pre-prompt model setup", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdModelSetup();
    fakeSessions.set("s1", session);

    const postRun = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "must not start", model: "openrouter/test-model" },
    });
    await vi.waitFor(() => {
      expect(runBroker.state("default", "s1").status).toBe("running");
    });
    expect(session.promptCalls).toHaveLength(0);

    const aborted = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(aborted.statusCode).toBe(200);
    session.releaseModelSetup();

    const response = await postRun;
    expect(response.statusCode).toBe(200);
    expect(session.aborted).toBe(true);
    expect(session.promptCalls).toHaveLength(0);
    expect(sseFrames(response.body).at(-1)?.type).toBe("done");
  });

  it("does not abort the Pi run when the initiating socket closes", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    fakeSessions.set("s1", session);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/sessions/s1/run`, {
      method: "POST",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      body: JSON.stringify({ message: "survive disconnect" }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.aborted).toBe(false);
    expect(runBroker.state("default", "s1").status).toBe("running");

    session.releasePrompt();
    await vi.waitFor(() => {
      expect(runBroker.state("default", "s1").status).toBe("complete");
    });
    expect(session.aborted).toBe(false);
  });
});
