import { afterEach, describe, expect, it } from "vitest";
import {
  agentFromSessionName,
  trackSubagentChildIdentity,
} from "../src/agent/subagent-child-identity.ts";

const savedEnv = {
  runId: process.env.PI_SUBAGENT_RUN_ID,
  agent: process.env.PI_SUBAGENT_CHILD_AGENT,
};

afterEach(() => {
  if (savedEnv.runId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
  else process.env.PI_SUBAGENT_RUN_ID = savedEnv.runId;
  if (savedEnv.agent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
  else process.env.PI_SUBAGENT_CHILD_AGENT = savedEnv.agent;
});

/** Minimal ExtensionAPI double: records `on` handlers so a test can fire them. */
function fakePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  return {
    handlers,
    api: {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[name] = handler;
      },
      registerTool: () => {},
    },
  };
}

function ctxWith(session: { id: string; file?: string; name?: string }) {
  return {
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getSessionName: () => session.name,
    },
  };
}

describe("agentFromSessionName", () => {
  it("reads the agent pi-subagents puts before the task excerpt", () => {
    expect(agentFromSessionName("researcher: Find primary sources on X")).toBe("researcher");
    expect(agentFromSessionName("statistical-reviewer")).toBe("statistical-reviewer");
    expect(agentFromSessionName("  worker: a: b  ")).toBe("worker");
  });

  it("rejects names that carry no agent", () => {
    expect(agentFromSessionName(undefined)).toBeUndefined();
    expect(agentFromSessionName("")).toBeUndefined();
    // An excerpt-only name (no agent) has whitespace in its head.
    expect(agentFromSessionName("Find primary sources on X")).toBeUndefined();
  });
});

describe("trackSubagentChildIdentity", () => {
  it("reports nothing before session_start and the session afterwards", async () => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const pi = fakePi();
    const identity = trackSubagentChildIdentity(pi.api as never);
    expect(identity()).toEqual({});

    await pi.handlers.session_start(
      {},
      ctxWith({ id: "sess-1", file: "/tmp/sessions/a.jsonl", name: "researcher: Survey the literature" }),
    );
    expect(identity()).toEqual({
      agent: "researcher",
      sessionId: "sess-1",
      sessionFile: "/tmp/sessions/a.jsonl",
      sessionName: "researcher: Survey the literature",
    });
  });

  it("omits the file and name when the session has none", async () => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const pi = fakePi();
    const identity = trackSubagentChildIdentity(pi.api as never);
    await pi.handlers.session_start({}, ctxWith({ id: "mem-1" }));
    expect(identity()).toEqual({ sessionId: "mem-1" });
  });

  it("lets a legacy per-process environment win over the session name", async () => {
    process.env.PI_SUBAGENT_RUN_ID = "run-7";
    process.env.PI_SUBAGENT_CHILD_AGENT = "biostatistician";
    const pi = fakePi();
    const identity = trackSubagentChildIdentity(pi.api as never);
    await pi.handlers.session_start(
      {},
      ctxWith({ id: "sess-2", file: "/tmp/sessions/b.jsonl", name: "researcher: x" }),
    );
    expect(identity()).toMatchObject({
      runId: "run-7",
      agent: "biostatistician",
      sessionId: "sess-2",
      sessionFile: "/tmp/sessions/b.jsonl",
    });
  });

  it("tolerates an ExtensionAPI double without `on`", () => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const identity = trackSubagentChildIdentity({ registerTool: () => {} } as never);
    expect(identity()).toEqual({});
  });
});
