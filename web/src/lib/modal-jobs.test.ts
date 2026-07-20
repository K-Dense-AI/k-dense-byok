import { describe, expect, it } from "vitest";

import {
  formatModalBytes,
  formatModalDuration,
  formatModalResource,
  isModalJobActive,
  isModalJobTerminal,
  modalJobIdFromActivity,
  parseModalCatalog,
  parseModalJob,
  parseModalJobsResponse,
  parseModalLogDelta,
} from "./modal-jobs";

describe("Modal catalog parsing", () => {
  it("normalizes the authoritative server catalog and multi-GPU metadata", () => {
    const catalog = parseModalCatalog({
      modalConfigured: true,
      instances: [
        {
          id: "h100-2",
          label: "2× H100",
          gpu: "H100",
          gpuCount: 2,
          cpu: 16,
          memoryMiB: 131072,
          pricePerHour: 9.12,
          fallback: "a100-80gb-2",
          cache: "project",
        },
      ],
      defaults: { instanceId: "h100-2", gpuCount: 2, cache: "project" },
    });

    expect(catalog.modalConfigured).toBe(true);
    expect(catalog.instances[0]).toMatchObject({
      id: "h100-2",
      gpu: "H100",
      gpuCount: 2,
      cpu: 16,
      pricePerHour: 9.12,
      fallback: "a100-80gb-2",
      cache: "project",
    });
    expect(catalog.defaults).toMatchObject({
      instanceId: "h100-2",
      gpuCount: 2,
      cache: "project",
    });
  });

  it("accepts snake-case catalog fields and rejects entries without ids", () => {
    const catalog = parseModalCatalog({
      modal_configured: false,
      instances: [
        { instance_id: "cpu-4", name: "4 CPU", cpu_cores: 4, price_per_hour: "0.20" },
        { label: "invalid" },
      ],
      defaults: { instance_id: "cpu-4" },
    });
    expect(catalog.instances).toHaveLength(1);
    expect(catalog.instances[0]).toMatchObject({
      id: "cpu-4",
      label: "4 CPU",
      cpu: 4,
      pricePerHour: 0.2,
    });
  });
});

describe("Modal job parsing", () => {
  it("normalizes lifecycle, resources, costs, transfers, and artifacts", () => {
    const job = parseModalJob({
      id: "job_123",
      sessionId: "session-1",
      groupId: "group-1",
      source: "modal_submit",
      agent: "lead",
      status: "succeeded",
      requestedResource: {
        instanceId: "h100-2",
        gpu: "H100",
        gpuCount: 2,
        timeoutSeconds: 600,
      },
      resolvedResource: {
        instanceId: "h100-2",
        label: "2× H100",
        gpu: "H100",
        gpuCount: 2,
        pricePerHour: 9.12,
      },
      timestamps: {
        created: "2026-07-20T10:00:00Z",
        started: "2026-07-20T10:00:02Z",
        finished: "2026-07-20T10:00:12Z",
      },
      costs: { spentUsd: 0.025, reservedUsd: 0, committedUsd: 0.025 },
      transfers: {
        inputs: [{ path: "data.csv", bytes: 1024, sha256: "abc" }],
        outputs: [
          {
            path: "/workspace/result.csv",
            localPath: "result.csv",
            bytes: 2048,
            status: "copied",
          },
        ],
      },
      exitCode: 0,
    });

    expect(job).toMatchObject({
      id: "job_123",
      status: "succeeded",
      groupId: "group-1",
      sessionId: "session-1",
      spentEstimatedUsd: 0.025,
      committedEstimatedUsd: 0.025,
      exitCode: 0,
    });
    expect(job?.requestedResource).toMatchObject({
      instanceId: "h100-2",
      gpu: "H100",
      gpuCount: 2,
    });
    expect(job?.inputTransfers[0]).toMatchObject({
      path: "data.csv",
      bytes: 1024,
      checksum: "abc",
    });
    expect(job?.artifacts).toEqual([
      expect.objectContaining({ path: "result.csv", bytes: 2048 }),
    ]);
  });

  it("parses wrapped list responses and server groups", () => {
    const response = parseModalJobsResponse({
      jobs: [
        { id: "one", status: "running" },
        { job_id: "two", status: "failed", error_message: "OOM" },
      ],
      groups: [
        { group_id: "batch-1", name: "Sweep", job_ids: ["one", "two"] },
      ],
    });
    expect(response.jobs.map((job) => job.id)).toEqual(["one", "two"]);
    expect(response.jobs[1].error).toBe("OOM");
    expect(response.groups[0]).toMatchObject({
      id: "batch-1",
      label: "Sweep",
      jobIds: ["one", "two"],
    });
  });

  it("normalizes the durable store's nested job wire shape", () => {
    const job = parseModalJob({
      id: "modal_123456",
      state: "running",
      request: {
        command: "python train.py",
        instance: "h100",
        gpuCount: 2,
        gpuFallback: ["a100-80gb"],
        timeoutSec: 900,
        groupId: "sweep-1",
        label: "Genome training sweep",
      },
      owner: {
        sessionId: "session-2",
        submittedBy: "subagent",
        subagentRunId: "worker-7",
      },
      createdAt: 1_753_050_000_000,
      runningAt: 1_753_050_002_000,
      reservationUsd: 2.28,
      effectiveInstance: "h100",
      effectiveGpu: "H100",
      pricePerHour: 9.12,
      error: null,
      inputFiles: [{ path: "data.csv", size: 10, sha256: "in" }],
      outputFiles: [{ path: "result.csv", size: 20, sha256: "out" }],
      missingOutputs: ["missing.csv"],
      accounting: { reconciled: false },
    });

    expect(job).toMatchObject({
      status: "running",
      sessionId: "session-2",
      groupId: "sweep-1",
      source: "subagent",
      agent: "subagent worker-7",
      command: "python train.py",
      reservedEstimatedUsd: 2.28,
    });
    expect(job?.requestedResource).toMatchObject({
      instanceId: "h100",
      gpuCount: 2,
      timeoutSeconds: 900,
      fallback: "a100-80gb",
      label: "h100",
    });
    expect(job?.resolvedResource).toMatchObject({
      instanceId: "h100",
      gpu: "H100",
      gpuCount: 2,
      pricePerHour: 9.12,
    });
    expect(job?.outputTransfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "result.csv", bytes: 20 }),
        expect.objectContaining({ path: "missing.csv", status: "missing" }),
      ]),
    );
    expect(job?.createdAt).toBe(new Date(1_753_050_000_000).toISOString());
  });

  it("distinguishes active and terminal statuses", () => {
    expect(isModalJobActive("collecting")).toBe(true);
    expect(isModalJobTerminal("succeeded")).toBe(true);
    expect(isModalJobTerminal("lost")).toBe(true);
  });
});

describe("Modal log and display helpers", () => {
  it("preserves byte cursors returned by the server", () => {
    expect(
      parseModalLogDelta(
        { stream: "stderr", cursor: 19, delta: "warning\n", truncated: false },
        "stderr",
        11,
      ),
    ).toEqual({
      stream: "stderr",
      after: 11,
      cursor: 19,
      delta: "warning\n",
      truncated: false,
      complete: false,
    });
  });

  it("accepts data/nextCursor/reset/eof log responses", () => {
    expect(
      parseModalLogDelta(
        { cursor: 11, nextCursor: 19, data: "warning\n", reset: true, eof: true },
        "stderr",
        7,
      ),
    ).toMatchObject({
      cursor: 19,
      delta: "warning\n",
      truncated: true,
      complete: true,
    });
  });

  it("formats resources, durations, and transfer sizes", () => {
    const job = parseModalJob({
      id: "job",
      status: "running",
      requestedResource: { label: "H100", gpu: "H100", gpuCount: 4 },
    });
    expect(formatModalResource(job!.requestedResource)).toBe("4× H100");
    expect(
      formatModalDuration(
        "2026-07-20T10:00:00Z",
        "2026-07-20T11:02:03Z",
      ),
    ).toBe("1h 2m 3s");
    expect(formatModalBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("extracts a job id from tool args, JSON, or prose", () => {
    expect(modalJobIdFromActivity({ args: { jobId: "job_args" } })).toBe("job_args");
    expect(
      modalJobIdFromActivity({ result: JSON.stringify({ job_id: "job_json" }) }),
    ).toBe("job_json");
    expect(modalJobIdFromActivity({ result: "Modal job id: job_prose queued" })).toBe(
      "job_prose",
    );
  });
});
