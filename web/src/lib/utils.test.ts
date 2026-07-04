import { describe, it, expect } from "vitest";
import { cn, isJunkFilePath } from "./utils";

describe("isJunkFilePath", () => {
  it("flags cache artifacts", () => {
    expect(isJunkFilePath("__pycache__/mod.cpython-313.pyc")).toBe(true);
    expect(isJunkFilePath("pkg/__pycache__/mod.pyc")).toBe(true);
    expect(isJunkFilePath("scripts/helper.pyo")).toBe(true);
    expect(isJunkFilePath(".DS_Store")).toBe(true);
    expect(isJunkFilePath("data/.DS_Store")).toBe(true);
    expect(isJunkFilePath(".ipynb_checkpoints/nb-checkpoint.ipynb")).toBe(true);
  });

  it("keeps real research files", () => {
    expect(isJunkFilePath("FINDINGS.md")).toBe(false);
    expect(isJunkFilePath("fem_solver.py")).toBe(false);
    expect(isJunkFilePath("results/_plotdata.npz")).toBe(false);
    expect(isJunkFilePath("my__pycache__notes.md")).toBe(false);
  });
});

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
