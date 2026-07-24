import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSessionRestore } from "./use-session-restore";
import type { SessionLoadOutcome } from "./use-agent";

/** Mirrors the tab wiring: `sessionId` is a prop that changes over the tab's life. */
function setup(
  initial: string | null,
  loadSession: (id: string) => Promise<SessionLoadOutcome>,
) {
  const onUnavailable = vi.fn();
  const view = renderHook(
    ({ sessionId }: { sessionId: string | null }) =>
      useSessionRestore({ sessionId, loadSession, onUnavailable }),
    { initialProps: { sessionId: initial } },
  );
  return { ...view, onUnavailable };
}

describe("useSessionRestore", () => {
  it("reports a stored session the backend no longer serves", async () => {
    const { result, onUnavailable } = setup("gone", async () => "gone");
    await waitFor(() => expect(result.current).toBe(true));
    expect(onUnavailable).toHaveBeenCalledWith("gone");
  });

  it("stays quiet for a fresh tab", async () => {
    const load = vi.fn(async (): Promise<SessionLoadOutcome> => "restored");
    const { result, onUnavailable } = setup(null, load);
    expect(result.current).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("does not re-load (or condemn) the tab's own new session", async () => {
    const load = vi.fn(async (): Promise<SessionLoadOutcome> => "restored");
    const { result, rerender, onUnavailable } = setup("stored", load);
    await waitFor(() => expect(result.current).toBe(true));

    // The tab ran a turn, so its descriptor now carries the live session id.
    await act(async () => {
      rerender({ sessionId: "freshly-started" });
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("stored");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("ignores the first session a fresh tab starts", async () => {
    const load = vi.fn(async (): Promise<SessionLoadOutcome> => "restored");
    const { result, rerender, onUnavailable } = setup(null, load);
    await act(async () => {
      rerender({ sessionId: "started-by-this-tab" });
    });

    expect(result.current).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("keeps the binding when a load is superseded or aborted", async () => {
    // React re-runs mount effects in development: the first load is aborted by
    // the intervening cleanup, and that says nothing about the session.
    const { result, onUnavailable } = setup("stored", async () => "superseded");
    await waitFor(() => expect(result.current).toBe(true));
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
