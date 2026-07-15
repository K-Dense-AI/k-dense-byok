import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/projects", () => ({
  listProjectActivities: vi.fn(),
}));

const { listProjectActivities } = await import("@/lib/projects");
const {
  PROJECT_ACTIVITY_POLL_MS,
  useProjectActivities,
} = await import("./use-project-activities");
const listSpy = listProjectActivities as unknown as ReturnType<typeof vi.fn>;

const activities = {
  alpha: { running: 1, needsInput: 0, errors: 0, blocked: 0, done: 0 },
};

describe("useProjectActivities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listSpy.mockReset();
    listSpy.mockResolvedValue(activities);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls only while the project directory is visible", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useProjectActivities(enabled),
      { initialProps: { enabled: false } },
    );
    expect(listSpy).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(activities);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_ACTIVITY_POLL_MS);
    });
    expect(listSpy).toHaveBeenCalledTimes(2);

    rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_ACTIVITY_POLL_MS * 2);
    });
    expect(listSpy).toHaveBeenCalledTimes(2);
    unmount();
  });
});
