import { afterEach, describe, expect, it, vi } from "vitest";
import { createFramePublisher } from "./frame-publisher";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("frame publisher", () => {
  it("coalesces display updates, but structural events flush immediately without trailing stale state", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const frames = createFramePublisher(publish);
    frames.schedule("a");
    frames.schedule("ab");
    expect(publish).not.toHaveBeenCalled();
    frames.publish("ab + tool");
    expect(publish.mock.calls).toEqual([["ab + tool"]]);
    vi.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(1);
    frames.schedule("abc");
    vi.advanceTimersByTime(60);
    expect(publish).toHaveBeenLastCalledWith("abc");
  });
  it("flushes on stop and cancels on reset/unmount", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const frames = createFramePublisher(publish);
    frames.schedule("last token");
    frames.flush();
    frames.schedule("old session");
    frames.cancel();
    vi.runAllTimers();
    expect(publish.mock.calls).toEqual([["last token"]]);
  });
  it("does not wait forever for RAF in a background tab", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const publish = vi.fn();
    createFramePublisher(publish).schedule("background");
    vi.advanceTimersByTime(50);
    expect(publish).toHaveBeenCalledWith("background");
  });
});
