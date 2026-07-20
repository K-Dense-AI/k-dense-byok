import { describe, expect, it } from "vitest";
import {
  getSessionComputeOptions,
  getSessionComputeTarget,
  setSessionComputeOptions,
  setSessionComputeTarget,
} from "../src/agent/modal-tool.ts";

describe("Modal compute target state", () => {
  it("isolates compute targets for the same session id across projects", () => {
    const sessionId = "shared-session";
    setSessionComputeTarget("project-a", sessionId, "h100");
    setSessionComputeTarget("project-b", sessionId, "cpu");

    expect(getSessionComputeTarget("project-a", sessionId)).toBe("h100");
    expect(getSessionComputeTarget("project-b", sessionId)).toBe("cpu");

    setSessionComputeTarget("project-a", sessionId, "local");
    expect(getSessionComputeTarget("project-a", sessionId)).toBeNull();
    expect(getSessionComputeTarget("project-b", sessionId)).toBe("cpu");
    setSessionComputeTarget("project-b", sessionId, null);
  });

  it("stores GPU count, fallback, and cache defaults per project session", () => {
    setSessionComputeOptions("project-a", "session", {
      gpuCount: 2,
      gpuFallback: ["l4"],
      cache: "none",
    });
    expect(getSessionComputeOptions("project-a", "session")).toEqual({
      gpuCount: 2,
      gpuFallback: ["l4"],
      cache: "none",
    });
    expect(getSessionComputeOptions("project-b", "session")).toBeUndefined();
    setSessionComputeOptions("project-a", "session", null);
    expect(getSessionComputeOptions("project-a", "session")).toBeUndefined();
  });
});
