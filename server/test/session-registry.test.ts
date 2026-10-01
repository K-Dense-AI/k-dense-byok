import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureProjectExists } from "../src/projects.ts";
import { SHUTDOWN_GRACE_MS, disposeProjectSessions, getSession } from "../src/agent/session-registry.ts";
import { subagentHost } from "../src/agent/subagent-control.ts";

const projectId = "session-registry";
afterEach(async () => {
  await disposeProjectSessions(projectId);
  vi.restoreAllMocks();
});

function savedSession() {
  const paths = ensureProjectExists(projectId);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const manager = SessionManager.create(paths.sandbox, paths.sessionsDir);
  manager.appendMessage({ role: "user", content: "A persisted conversation", timestamp: Date.now() });
  return { paths, sessionId: manager.getSessionId() };
}

describe("cold session opens", () => {
  it("shares one real Pi session and extension host across concurrent requests", async () => {
    const { paths, sessionId } = savedSession();
    const warnings = vi.spyOn(console, "warn");
    const sessions = await Promise.all([
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
    ]);
    expect(sessions[0]).not.toBeNull();
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).toBe(sessions[0]);
    expect(await getSession(projectId, paths, sessionId)).toBe(sessions[0]);
    expect(warnings.mock.calls.some((args) => String(args[0]).includes("[session-registry] extension error"))).toBe(false);
    expect(await subagentHost(projectId, sessionId).rpc("status")).toHaveProperty("asyncSnapshot");
  }, 30_000);

  it("shares a failed opening attempt and allows a fresh retry", async () => {
    const { paths, sessionId } = savedSession();
    // The real construction path first opens the JSONL. Fail that operation
    // once without mocking getSession or the session/extension implementation.
    const open = vi.spyOn(SessionManager, "open").mockImplementationOnce(() => {
      throw new Error("Temporary session read failure");
    });
    const attempts = await Promise.allSettled([
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    expect(open).toHaveBeenCalledTimes(1);
    const retried = await getSession(projectId, paths, sessionId);
    expect(retried?.sessionId).toBe(sessionId);
    expect(open).toHaveBeenCalledTimes(2);
    expect(await getSession(projectId, paths, sessionId)).toBe(retried);
  }, 30_000);

  it("does not cache a missing session", async () => {
    const { paths, sessionId } = savedSession();
    vi.spyOn(SessionManager, "list").mockResolvedValueOnce([]);
    expect(await getSession(projectId, paths, sessionId)).toBeNull();
    expect((await getSession(projectId, paths, sessionId))?.sessionId).toBe(sessionId);
  }, 30_000);
});

describe("session release", () => {
  it("disposes after the grace period when a shutdown handler never settles", async () => {
    const { paths, sessionId } = savedSession();
    const session = (await getSession(projectId, paths, sessionId))!;
    const emit = vi.spyOn(session.extensionRunner, "emit").mockReturnValue(new Promise(() => {}));
    const dispose = vi.spyOn(session, "dispose");
    vi.useFakeTimers();
    try {
      const released = disposeProjectSessions(projectId);
      await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await released;
      expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
