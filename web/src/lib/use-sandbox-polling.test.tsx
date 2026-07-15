import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/projects", () => ({
  API_BASE: "http://localhost:8000",
  apiFetch: vi.fn(),
  getActiveProjectId: () => "project-a",
  useProjectScopeId: () => "project-a",
}));

const { apiFetch } = await import("@/lib/projects");
const { useSandbox } = await import("./use-sandbox");
const fetchSpy = apiFetch as unknown as ReturnType<typeof vi.fn>;

function treeResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === "etag" ? '"tree-v1"' : null },
    json: async () => ({
      name: "sandbox",
      type: "directory",
      path: "",
      children: [],
    }),
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSandbox polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(treeResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does no background work while its project is inactive", async () => {
    const { unmount } = renderHook(() => useSandbox(false));
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("refreshes immediately and then every 15 seconds while active", async () => {
    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useSandbox(active),
      { initialProps: { active: true } },
    );
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("revalidates with the tree ETag and skips unchanged response bodies", async () => {
    const json = vi.fn(async () => ({
      name: "sandbox",
      type: "directory",
      path: "",
      children: [],
    }));
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => '"tree-v1"' },
        json,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: { get: () => '"tree-v1"' },
        json: vi.fn(() => {
          throw new Error("304 response must not be parsed");
        }),
      });

    const { unmount } = renderHook(() => useSandbox(true));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/sandbox/tree",
      expect.objectContaining({
        headers: { "If-None-Match": '"tree-v1"' },
      }),
      "project-a",
    );
    expect(json).toHaveBeenCalledTimes(1);
    unmount();
  });
});
