import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNotebookPolling } from "./use-notebook-polling";

type Props = Parameters<typeof useNotebookPolling>[0];

const base = (over: Partial<Props> = {}): Props => ({
  enabled: true,
  refetch: vi.fn(),
  signature: "a,b",
  resetKey: 0,
  ...over,
});

describe("useNotebookPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls refetch every interval while enabled", () => {
    const refetch = vi.fn();
    renderHook((p: Props) => useNotebookPolling(p), { initialProps: base({ refetch }) });
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("does not poll when disabled", () => {
    const refetch = vi.fn();
    renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch, enabled: false }),
    });
    vi.advanceTimersByTime(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("goes dormant after maxQuietPolls ticks with an unchanged signature", () => {
    const refetch = vi.fn();
    renderHook((p: Props) => useNotebookPolling(p), { initialProps: base({ refetch }) });
    vi.advanceTimersByTime(5000 * 6);
    expect(refetch).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(5000 * 10);
    expect(refetch).toHaveBeenCalledTimes(6); // dormant
  });

  it("resets the quiet counter when the signature changes", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch }),
    });
    vi.advanceTimersByTime(5000 * 6);
    expect(refetch).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(5000 * 2);
    expect(refetch).toHaveBeenCalledTimes(6); // dormant

    rerender(base({ refetch, signature: "a,b,c" })); // new entries landed
    vi.advanceTimersByTime(5000 * 2);
    expect(refetch).toHaveBeenCalledTimes(8); // woke back up
  });

  it("restarts after dormancy when resetKey bumps", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch }),
    });
    vi.advanceTimersByTime(5000 * 7);
    expect(refetch).toHaveBeenCalledTimes(6); // dormant

    rerender(base({ refetch, resetKey: 1 }));
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(7);
  });

  it("honors a custom intervalMs and maxQuietPolls", () => {
    const refetch = vi.fn();
    renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch, intervalMs: 1000, maxQuietPolls: 2 }),
    });
    vi.advanceTimersByTime(1000 * 5);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("stops the interval on unmount", () => {
    const refetch = vi.fn();
    const { unmount } = renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch }),
    });
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(30_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("stops polling when enabled flips to false", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook((p: Props) => useNotebookPolling(p), {
      initialProps: base({ refetch }),
    });
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender(base({ refetch, enabled: false }));
    vi.advanceTimersByTime(30_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
