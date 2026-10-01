import { describe, expect, it } from "vitest";
import path from "node:path";
import { runtimePaths } from "../src/runtime-paths.ts";

describe("installed application paths", () => {
  const home = path.resolve("/test-user");
  it("preserves source checkout defaults", () => {
    const paths = runtimePaths({}, "darwin", home);
    expect(paths.projects).toBe(path.join(paths.resources, "projects"));
    expect(paths.credentials).toBe(path.join(paths.resources, ".env"));
  });
  it("separates macOS resources, data and cache", () => {
    const paths = runtimePaths({ KADY_PACKAGED: "1" }, "darwin", home);
    expect(paths.projects).toBe(path.join(home, "Library", "Application Support", "Kady", "projects"));
    expect(paths.cache).toBe(path.join(home, "Library", "Caches", "Kady"));
    expect(paths.credentials.startsWith(paths.resources)).toBe(false);
  });
  it("honors Linux XDG roots and explicit workspace configuration", () => {
    const paths = runtimePaths({ KADY_PACKAGED: "1", XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), KADY_PROJECTS_ROOT: path.join(home, "existing projects") }, "linux", home);
    expect(paths.credentials).toBe(path.join(home, "config", "kady", ".env"));
    expect(paths.projects).toBe(path.join(home, "existing projects"));
    expect(paths.cache).toBe(path.join(home, "cache", "kady"));
  });
  it("uses per-user LocalAppData on Windows", () => {
    const local = path.join(home, "AppData", "Local");
    const paths = runtimePaths({ KADY_PACKAGED: "1", LOCALAPPDATA: local }, "win32", home);
    expect(paths.data).toBe(path.join(local, "Kady"));
    expect(paths.cache).toBe(path.join(local, "Kady", "cache"));
  });
});
