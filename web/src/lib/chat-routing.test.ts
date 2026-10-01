import { describe, expect, it } from "vitest";
import { routeSubmit } from "@/lib/chat-routing";

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

describe("disconnected runs", () => {
  it("retains both steering and image submissions locally until reconnection completes", () => {
    expect(routeSubmit(true, "auto", false, true)).toBe("localQueue");
    expect(routeSubmit(true, "queue", true, true)).toBe("localQueue");
  });
});
