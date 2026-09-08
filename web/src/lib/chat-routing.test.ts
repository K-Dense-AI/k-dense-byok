import { describe, expect, it } from "vitest";
import { routeSubmit, steerNotStreamingFallback } from "@/lib/chat-routing";

describe("routeSubmit", () => {
  it("sends normally when idle, regardless of intent or images", () => {
    expect(routeSubmit(false, "auto")).toBe("send");
    expect(routeSubmit(false, "queue")).toBe("send");
    expect(routeSubmit(false, "auto", true)).toBe("send");
  });
  it("steers by default while streaming", () => {
    expect(routeSubmit(true, "auto")).toBe("steer");
  });
  it("queues a Pi follow-up on explicit intent while streaming", () => {
    expect(routeSubmit(true, "queue")).toBe("followUp");
  });
  it("routes an image message to a follow-up while streaming (steering is text-only)", () => {
    expect(routeSubmit(true, "auto", true)).toBe("followUp");
  });
});

describe("steerNotStreamingFallback", () => {
  it("preserves order behind a non-empty queue", () => {
    expect(steerNotStreamingFallback(2)).toBe("queue");
  });
  it("sends directly when the queue is empty", () => {
    expect(steerNotStreamingFallback(0)).toBe("send");
  });
});
