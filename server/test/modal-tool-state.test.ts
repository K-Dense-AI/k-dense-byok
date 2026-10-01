import { describe, expect, it } from "vitest";
import { createProject } from "../src/projects.ts";
import {
  getSessionComputeOptions,
  getSessionComputeTarget,
  makeModalTools,
  publicJob,
  requestFromParams,
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

describe("Modal tool requests and results", () => {
  const chatOptions = { gpuCount: 2, gpuFallback: ["a100-80gb"], cache: "none" as const };

  it("applies the chat's GPU options only to the chat's own instance", () => {
    expect(requestFromParams({ command: "python fit.py" }, "h100", chatOptions)).toMatchObject({
      instance: "h100", gpuCount: 2, gpuFallback: ["a100-80gb"], cache: "none",
    });
    expect(requestFromParams({ command: "python fit.py", instance: "h100" }, "h100", chatOptions)).toMatchObject({ gpuCount: 2 });
    // A CPU job the model chose must not reserve, or fall back onto, the chat's GPU chain.
    const cpu = requestFromParams({ command: "python summarize.py", instance: "cpu-4" }, "h100", chatOptions);
    expect(cpu).toMatchObject({ instance: "cpu-4", cache: "none" });
    expect(cpu.gpuCount).toBeUndefined();
    expect(cpu.gpuFallback).toBeUndefined();
    // Explicit arguments still win.
    expect(requestFromParams({ command: "x", instance: "l4", gpu_count: 1, gpu_fallback: ["t4"] }, "h100", chatOptions))
      .toMatchObject({ gpuCount: 1, gpuFallback: ["t4"] });
  });

  it("caps transfer manifests in the result the model sees", () => {
    const outputFiles = Array.from({ length: 1200 }, (_, i) => ({ path: `out/${i}.csv`, size: 1 }));
    const job = {
      id: "job-1", state: "succeeded", request: { label: "sweep", instance: "cpu", command: "x" },
      outputFiles, missingOutputs: ["a", "b"], accounting: { estimatedCostUsd: 0.1 }, createdAt: 1,
    } as unknown as Parameters<typeof publicJob>[0];
    const shown = publicJob(job);
    expect(shown.files_out).toHaveLength(51);
    expect(shown.files_out?.at(-1)).toBe("… 1150 more");
    expect(shown.files_out_total).toBe(1200);
    expect(shown.missing_outputs).toEqual(["a", "b"]);
  });

  it("reports failures as errors with a recovery hint", async () => {
    const projectId = createProject({ name: "Modal hints" }).id;
    const submit = makeModalTools(projectId, () => "session").find((tool) => tool.name === "modal_submit")!;
    const result = await submit.execute("call", { command: "python fit.py" }, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: "NOT_CONFIGURED" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Settings → Services") });
  });
});
