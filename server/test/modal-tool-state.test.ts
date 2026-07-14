import { describe, expect, it } from "vitest";
import {
  getSessionComputeTarget,
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
});
