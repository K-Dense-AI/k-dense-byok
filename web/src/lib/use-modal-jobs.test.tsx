import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODAL_CREDENTIALS_CHANGED_EVENT,
  MODAL_JOB_FINISHED_EVENT,
  MODAL_JOBS_CHANGED_EVENT,
} from "./modal-jobs";
import {
  useModalCatalog,
  useModalJob,
  useModalJobLogs,
  useModalJobs,
} from "./use-modal-jobs";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Modal data hooks", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes the server compute catalog immediately after credential changes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          modalConfigured: false,
          instances: [{ id: "cpu", label: "CPU", gpu: null, pricePerHour: 0.05 }],
          defaults: { instanceId: "cpu" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          modalConfigured: true,
          instances: [{ id: "h100", label: "H100", gpu: "H100", pricePerHour: 4.56 }],
          defaults: { instanceId: "h100" },
        }),
      );

    const { result } = renderHook(() => useModalCatalog("project-a"));
    await waitFor(() => expect(result.current.catalog?.instances[0].id).toBe("cpu"));

    act(() => window.dispatchEvent(new Event(MODAL_CREDENTIALS_CHANGED_EVENT)));
    await waitFor(() => expect(result.current.catalog?.modalConfigured).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls active jobs quickly, slows/stops for terminal jobs, and broadcasts completion", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ jobs: [{ id: "job-1", status: "running", sessionId: "s1" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [{ id: "job-1", status: "succeeded", sessionId: "s1" }],
        }),
      );
    const finished = vi.fn();
    window.addEventListener(MODAL_JOB_FINISHED_EVENT, finished);

    const { result } = renderHook(() =>
      useModalJobs({
        projectId: "project-a",
        activePollMs: 5,
        idlePollMs: 0,
      }),
    );

    await waitFor(() => expect(result.current.jobs[0]?.status).toBe("succeeded"));
    expect(result.current.activeCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledOnce();
    const event = finished.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toMatchObject({
      projectId: "project-a",
      jobId: "job-1",
      sessionId: "s1",
      status: "succeeded",
    });
    window.removeEventListener(MODAL_JOB_FINISHED_EVENT, finished);
  });

  it("stops detail polling after a terminal response and exposes mutations", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "job-2", status: "failed" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "job-2-retry", status: "queued", retryOf: "job-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "job-2", status: "failed" }));
    const changed = vi.fn();
    window.addEventListener(MODAL_JOBS_CHANGED_EVENT, changed);

    const { result } = renderHook(() =>
      useModalJob("job-2", { projectId: "project-a", activePollMs: 5 }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let retried: unknown;
    await act(async () => {
      retried = await result.current.retry();
    });
    expect(retried).toMatchObject({ id: "job-2-retry", status: "queued" });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(MODAL_JOBS_CHANGED_EVENT, changed);
  });

  it("retries detail polling after a transient failure instead of freezing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "job-4", status: "running" }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ id: "job-4", status: "succeeded" }));

    const { result } = renderHook(() =>
      useModalJob("job-4", { projectId: "project-a", activePollMs: 5 }),
    );
    // A server restart mid-job used to stop the poll for good, leaving a
    // running job's detail view stuck until a manual refresh.
    await waitFor(() => expect(result.current.job?.status).toBe("succeeded"));
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up on a detail poll that keeps failing", async () => {
    fetchMock.mockRejectedValue(new Error("gone"));
    const { result } = renderHook(() =>
      useModalJob("job-5", { projectId: "project-a", activePollMs: 1 }),
    );
    await waitFor(() => expect(result.current.error).toBe("gone"));
    // 1 initial + at most MAX_DETAIL_POLL_FAILURES retries; the point is that
    // it stops rather than hammering a dead id forever.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    const settled = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(settled);
  });

  it("advances log requests by the server's byte cursor and stops at complete", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ cursor: 5, delta: "hello", complete: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ cursor: 12, delta: " world", complete: true }),
      );

    const { result } = renderHook(() =>
      useModalJobLogs("job-3", "stdout", {
        projectId: "project-a",
        active: true,
        pollMs: 5,
      }),
    );
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.content).toBe("hello world");
    expect(result.current.cursor).toBe(12);
    expect(String(fetchMock.mock.calls[0][0])).toContain("after=0");
    expect(String(fetchMock.mock.calls[1][0])).toContain("after=5");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
