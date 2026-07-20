import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseModalJob, type ModalJobDetail } from "@/lib/modal-jobs";

const hooks = vi.hoisted(() => ({
  useModalCatalog: vi.fn(),
  useModalJobs: vi.fn(),
  useModalJob: vi.fn(),
  useModalJobLogs: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  results: vi.fn(),
}));

vi.mock("@/lib/use-modal-jobs", () => ({
  useModalCatalog: hooks.useModalCatalog,
  useModalJobs: hooks.useModalJobs,
  useModalJob: hooks.useModalJob,
  useModalJobLogs: hooks.useModalJobLogs,
}));

import { ModalJobsPanel } from "./modal-jobs-panel";

function job(
  status: ModalJobDetail["status"] = "running",
  id = "job-123",
): ModalJobDetail {
  return parseModalJob({
    id,
    groupId: "batch-1",
    sessionId: "session-1",
    status,
    source: "modal_submit",
    requestedResource: {
      instanceId: "h100-2",
      label: "H100 pair",
      gpu: "H100",
      gpuCount: 2,
      timeoutSeconds: 600,
    },
    resolvedResource: {
      instanceId: "h100-2",
      label: "H100 pair",
      gpu: "H100",
      gpuCount: 2,
      pricePerHour: 9.12,
    },
    createdAt: "2026-07-20T10:00:00Z",
    startedAt: "2026-07-20T10:00:02Z",
    spentEstimatedUsd: 0.02,
    reservedEstimatedUsd: 1.5,
    outputTransfers: [
      { path: "/workspace/result.csv", localPath: "result.csv", bytes: 100 },
    ],
  })!;
}

describe("ModalJobsPanel", () => {
  beforeEach(() => {
    hooks.cancel.mockReset();
    hooks.retry.mockReset();
    hooks.results.mockReset();
    hooks.useModalCatalog.mockReturnValue({
      catalog: {
        modalConfigured: true,
        instances: [],
        defaults: {
          instanceId: null,
          gpuCount: 1,
          fallback: null,
          cache: null,
          raw: {},
        },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    hooks.useModalJobs.mockReturnValue({
      jobs: [job()],
      groups: [
        {
          id: "batch-1",
          label: "Parameter sweep",
          status: null,
          jobIds: ["job-123"],
          createdAt: null,
          raw: {},
        },
      ],
      loading: false,
      refreshing: false,
      error: null,
      activeCount: 1,
      refresh: vi.fn(),
    });
    hooks.useModalJob.mockReturnValue({
      job: job(),
      loading: false,
      mutating: null,
      error: null,
      refresh: vi.fn(),
      cancel: hooks.cancel,
      retry: hooks.retry,
      results: hooks.results,
    });
    hooks.useModalJobLogs.mockReturnValue({
      content: "training\nstep 1\n",
      cursor: 16,
      loading: false,
      error: null,
      truncated: false,
      complete: false,
      refresh: vi.fn(),
    });
  });

  it("renders grouped project jobs, filters, status, resources, and live detail", () => {
    render(
      <ModalJobsPanel
        projectId="project-a"
        sessionId="session-1"
        scope="project"
        onScopeChange={() => {}}
        focusJob={{ id: "job-123", token: 1 }}
        onOpenOutput={() => {}}
      />,
    );

    expect(screen.getByText("Parameter sweep")).toBeInTheDocument();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("Requested resource")).toBeInTheDocument();
    expect(screen.getByText("Resolved resource")).toBeInTheDocument();
    expect(screen.getByLabelText("stdout log")).toHaveTextContent("step 1");
    expect(screen.getByText("Estimated reserved")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter jobs by status"), {
      target: { value: "succeeded" },
    });
    expect(hooks.useModalJobs).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("supports session scope and cancelling an active job", () => {
    const onScopeChange = vi.fn();
    render(
      <ModalJobsPanel
        projectId="project-a"
        sessionId="session-1"
        scope="project"
        onScopeChange={onScopeChange}
        focusJob={{ id: "job-123", token: 1 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "This chat" }));
    expect(onScopeChange).toHaveBeenCalledWith("session");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hooks.cancel).toHaveBeenCalledOnce();
  });

  it("shows failure details and retry controls", () => {
    const failed = { ...job("failed"), error: "CUDA out of memory", exitCode: 137 };
    hooks.useModalJob.mockReturnValue({
      job: failed,
      loading: false,
      mutating: null,
      error: null,
      refresh: vi.fn(),
      cancel: hooks.cancel,
      retry: hooks.retry.mockResolvedValue(null),
      results: hooks.results,
    });
    render(
      <ModalJobsPanel
        projectId="project-a"
        sessionId="session-1"
        scope="project"
        onScopeChange={() => {}}
        focusJob={{ id: "job-123", token: 1 }}
      />,
    );
    expect(screen.getByText("CUDA out of memory")).toBeInTheDocument();
    expect(screen.getByText("Exit code 137")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hooks.retry).toHaveBeenCalledOnce();
  });
});
