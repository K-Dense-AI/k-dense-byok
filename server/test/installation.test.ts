import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), uv: vi.fn(() => "/bundled/uv") }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/binaries.ts", () => ({ findUv: mocks.uv, firstRunnable: vi.fn() }));
let temp: string;
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules(); mocks.spawn.mockReset(); mocks.uv.mockReturnValue("/bundled/uv");
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-components-"));
  vi.stubEnv("KADY_PACKAGED", "1"); vi.stubEnv("KADY_DATA_DIR", temp); vi.stubEnv("KADY_CACHE_DIR", temp); vi.stubEnv("KADY_PYTHON", "");
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }); mocks.spawn.mockReturnValue(child);
});
afterEach(() => { child.emit("close", 1); vi.unstubAllEnvs(); fs.rmSync(temp, { recursive: true, force: true }); });

describe("scientific component setup", () => {
  it("returns immediately, coalesces requests, and installs a frozen environment outside application resources", async () => {
    const { installHelpers, helperStatus } = await import("../src/installation.ts");
    expect(installHelpers().status).toBe("installing"); installHelpers();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe("/bundled/uv"); expect(args).toContain("--frozen"); expect(args).toContain("3.12.14");
    expect(options.env.UV_PROJECT_ENVIRONMENT.startsWith(temp)).toBe(true);
    child.stderr.emit("data", Buffer.from("Downloading scientific tools\n"));
    expect(helperStatus().detail).toBe("Downloading scientific tools");
  });
  it("never treats partial environments as installed and allows a failed download to retry", async () => {
    const { installHelpers, helperStatus } = await import("../src/installation.ts");
    const { helperEnvironmentDir } = await import("../src/helpers-env.ts");
    installHelpers(); child.emit("close", 1);
    expect(helperStatus().status).toBe("error");
    expect(fs.existsSync(path.join(helperEnvironmentDir(), ".kady-ready"))).toBe(false);
    expect(installHelpers().status).toBe("installing"); expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it("restores completed setup after a backend restart", async () => {
    const { installHelpers } = await import("../src/installation.ts");
    const { helperPython, helperEnvironmentDir } = await import("../src/helpers-env.ts");
    installHelpers(); const executable = path.join(helperEnvironmentDir(), ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "");
    expect(helperPython()).toBe(executable); child.emit("close", 0);
    vi.resetModules(); const restarted = await import("../src/installation.ts");
    expect(restarted.helperStatus().status).toBe("ready");
  });
});
