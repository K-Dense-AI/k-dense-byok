import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { runBroker, type RunMetadata } from "../src/agent/run-broker.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import {
  summarizeProjectActivity,
} from "../src/project-activity.ts";
import {
  ensureProjectExists,
  resolvePaths,
} from "../src/projects.ts";

const app = await buildApp();

function metadata(): RunMetadata {
  return {
    runId: "run-1",
    prompt: "Analyze the data",
    images: [],
    baseline: { messages: [], contextUsage: null },
  };
}

beforeEach(() => {
  runBroker.clear();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  runBroker.clear();
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("project activity", () => {
  it("prioritizes live and attention states over historical completion", () => {
    expect(summarizeProjectActivity({
      runs: [
        { sessionId: "running", state: "running" },
        { sessionId: "error", state: "error" },
        { sessionId: "blocked", state: "blocked" },
        { sessionId: "done", state: "done" },
      ],
      hasPendingInterview: (sessionId) => sessionId === "running",
      budgetBlocked: true,
    })).toEqual({
      running: 0,
      needsInput: 1,
      errors: 1,
      blocked: 1,
      done: 1,
    });
  });

  it("reports all projects without mounting their workspaces", async () => {
    ensureProjectExists("alpha");
    const paths = resolvePaths("alpha");
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.sessionsDir, "chat-1.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "chat-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: paths.sandbox,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Analyze" }],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: 2,
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const historical = await app.inject({
      method: "GET",
      url: "/projects/activity",
    });
    expect(historical.statusCode).toBe(200);
    expect(historical.json().activities.alpha).toMatchObject({
      running: 0,
      done: 1,
    });

    runBroker.start("alpha", "chat-1", metadata());
    const running = await app.inject({
      method: "GET",
      url: "/projects/activity",
    });
    expect(running.json().activities.alpha).toMatchObject({
      running: 1,
      done: 0,
    });
  });
});
