import { describe, it, expect } from "vitest";
import { mintRunId, setSessionRunId, currentRunId } from "../src/agent/run-ids.ts";

describe("run-ids", () => {
  it("mints unique ids with the run_ prefix", () => {
    const a = mintRunId();
    const b = mintRunId();
    expect(a).toMatch(/^run_/);
    expect(b).toMatch(/^run_/);
    expect(a).not.toBe(b);
  });

  it("returns undefined for a session with no live run", () => {
    expect(currentRunId("project-a", "run-ids-none")).toBeUndefined();
  });

  it("isolates the same session id across projects", () => {
    const sessionId = "shared-session";
    setSessionRunId("project-a", sessionId, "run_x");
    setSessionRunId("project-b", sessionId, "run_y");

    expect(currentRunId("project-a", sessionId)).toBe("run_x");
    expect(currentRunId("project-b", sessionId)).toBe("run_y");
  });

  it("clears the run id when set to null", () => {
    setSessionRunId("project-a", "run-ids-c", "run_z");
    expect(currentRunId("project-a", "run-ids-c")).toBe("run_z");
    setSessionRunId("project-a", "run-ids-c", null);
    expect(currentRunId("project-a", "run-ids-c")).toBeUndefined();
  });
});
