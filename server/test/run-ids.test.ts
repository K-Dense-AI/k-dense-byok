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
    expect(currentRunId("run-ids-none")).toBeUndefined();
  });

  it("stores and retrieves a run id per session", () => {
    setSessionRunId("run-ids-a", "run_x");
    setSessionRunId("run-ids-b", "run_y");
    expect(currentRunId("run-ids-a")).toBe("run_x");
    expect(currentRunId("run-ids-b")).toBe("run_y");
  });

  it("clears the run id when set to null", () => {
    setSessionRunId("run-ids-c", "run_z");
    expect(currentRunId("run-ids-c")).toBe("run_z");
    setSessionRunId("run-ids-c", null);
    expect(currentRunId("run-ids-c")).toBeUndefined();
  });
});
