import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstRunnable, hasBinary, lookPath, resetBinaryCache } from "../src/binaries.ts";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-binaries-"));
  fs.writeFileSync(path.join(dir, "tool.EXE"), "");
  fs.writeFileSync(path.join(dir, "plain"), "");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetBinaryCache();
});

describe("lookPath", () => {
  it("finds a PATHEXT-named file on win32 without an exec bit", () => {
    const env = { PATH: dir, PATHEXT: ".COM;.EXE" };
    expect(lookPath("tool", { env, platform: "win32" })).toBe(path.join(dir, "tool.EXE"));
  });

  it("matches an explicit extension as-is on win32", () => {
    const env = { PATH: dir, PATHEXT: ".COM;.EXE" };
    expect(lookPath("tool.EXE", { env, platform: "win32" })).toBe(path.join(dir, "tool.EXE"));
  });

  it("ignores files without a PATHEXT extension on win32", () => {
    const env = { PATH: dir, PATHEXT: ".COM;.EXE" };
    expect(lookPath("plain", { env, platform: "win32" })).toBeNull();
  });

  it("splits PATH on the platform delimiter", () => {
    const env = { PATH: `${os.tmpdir()};${dir}`, PATHEXT: ".EXE" };
    expect(lookPath("tool", { env, platform: "win32" })).toBe(path.join(dir, "tool.EXE"));
  });

  // Host-dependent: posix-mode semantics (exec bit, ':' PATH delimiter,
  // '/'-only separators) can't be faithfully exercised against a Windows
  // filesystem, so these two run on posix hosts only. The win32-mode tests
  // above run everywhere — they only need existence checks.
  it.skipIf(process.platform === "win32")("requires the exec bit on posix", () => {
    const env = { PATH: dir };
    expect(lookPath("plain", { env, platform: "linux" })).toBeNull();
    fs.chmodSync(path.join(dir, "plain"), 0o755);
    expect(lookPath("plain", { env, platform: "linux" })).toBe(path.join(dir, "plain"));
  });

  it.skipIf(process.platform === "win32")(
    "checks a separator-containing command directly, not via PATH",
    () => {
      const abs = path.join(dir, "plain");
      expect(lookPath(abs, { env: { PATH: "" }, platform: "linux" })).toBe(abs);
      expect(lookPath(path.join(dir, "missing"), { env: {}, platform: "linux" })).toBeNull();
    },
  );

  it("unquotes double-quoted Windows PATH entries", () => {
    const env = { PATH: `"${dir}"`, PATHEXT: ".EXE" };
    expect(lookPath("tool", { env, platform: "win32" })).toBe(path.join(dir, "tool.EXE"));
  });

  it("returns null for an empty PATH", () => {
    expect(lookPath("tool", { env: {}, platform: "win32" })).toBeNull();
  });
});

describe("hasBinary / firstRunnable", () => {
  it("hasBinary caches until reset", () => {
    resetBinaryCache();
    // `node` is guaranteed present (it's running the tests).
    expect(hasBinary("node")).toBe(true);
    expect(hasBinary("kady-definitely-not-a-binary")).toBe(false);
    resetBinaryCache();
    expect(hasBinary("node")).toBe(true);
  });

  it("firstRunnable picks the first candidate whose --version succeeds", () => {
    resetBinaryCache();
    expect(firstRunnable(["kady-definitely-not-a-binary", "node"])).toBe("node");
    expect(firstRunnable(["kady-definitely-not-a-binary"])).toBeNull();
  });
});
