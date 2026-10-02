import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/projects", () => ({
  apiFetch: vi.fn(),
  useProjectScopeId: () => "p1",
}));

const { apiFetch } = await import("@/lib/projects");
const { useProjectCost } = await import("./use-project-cost");
const spy = apiFetch as unknown as ReturnType<typeof vi.fn>;

const summary = (totalUsd: number) => ({ ok: true, json: async () => ({ projectId: "p1", totalUsd, budget: { totalUsd, limitUsd: null, ratio: null, state: "ok" } }) });

describe("useProjectCost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("picks up spend that lands with no turn in any open tab, without dimming the pill", async () => {
    spy.mockResolvedValueOnce(summary(1.27)).mockResolvedValue(summary(2.48));
    const { result } = renderHook(() => useProjectCost(0));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.summary.totalUsd).toBe(1.27);

    // A schedule fire on the hidden resident session ledgers $1.21 meanwhile.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(result.current.loading).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.summary.totalUsd).toBe(2.48);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
