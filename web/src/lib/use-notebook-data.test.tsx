import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useNotebookData } from "./use-notebook-data";
vi.mock("./projects", () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import("./projects");
const fetch = vi.mocked(apiFetch);
const row = (title: string) => ({ id: "same", type: "note", title, timestamp: 1 });
const response = (title: string) => ({ ok: true, json: async () => ({ entries: [row(title)] }) }) as Response;
const opts = { projectId: "a", url: "/sessions/same/notebook", revision: "0", poll: true, active: true };
beforeEach(() => { vi.clearAllMocks(); fetch.mockResolvedValue(response("A")); });
afterEach(() => { vi.useRealTimers(); });

describe("useNotebookData", () => {
  it("fetches a new project immediately even while the old same-session request is pending", async () => {
    let resolveOld!: (value: Response) => void;
    fetch.mockImplementation((_url, _init, project) => project === "a" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(response("B")));
    const { result, rerender } = renderHook((props) => useNotebookData(props), { initialProps: opts });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender({ ...opts, projectId: "b" });
    await waitFor(() => expect(result.current.entries[0]?.title).toBe("B"));
    await act(async () => { resolveOld(response("Late A")); });
    expect(result.current.entries[0].title).toBe("B");
    expect((fetch.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  });
  it("does not let a slow old revision overwrite a refreshed record", async () => {
    let resolveOld!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const { result, rerender } = renderHook((props) => useNotebookData(props), { initialProps: opts });
    rerender({ ...opts, revision: "1" });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { resolveOld(response("Late")); });
    expect(result.current.entries[0].title).toBe("A");
  });
  it("polls the project with no active chat and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useNotebookData({ ...opts, url: "/projects/a/notebook", active: false }));
    await act(async () => {});
    expect(result.current.loaded).toBe(true);
    fetch.mockResolvedValue(response("Other chat"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.entries[0].title).toBe("Other chat");
    unmount();
    const calls = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it("keeps last-known rows but exposes failed refreshes; manual retry recovers", async () => {
    const { result } = renderHook(() => useNotebookData(opts));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    fetch.mockResolvedValue({ ok: false, status: 500 } as Response);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.entries[0].title).toBe("A");
    fetch.mockResolvedValue(response("Recovered"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.entries[0].title).toBe("Recovered"));
    expect(result.current.error).toBe(false);
  });
});
