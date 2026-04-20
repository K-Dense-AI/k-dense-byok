import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("concatenates class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("dedupes tailwind class conflicts in favor of the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("filters out falsy values", () => {
    expect(cn("a", false && "never", null, undefined, "b")).toBe("a b");
  });

  it("handles conditional objects", () => {
    expect(cn("a", { b: true, c: false })).toBe("a b");
  });
});
