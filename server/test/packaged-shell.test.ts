import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyPackagedShell, registerPackagedShell } from "../src/agent/packaged-shell.ts";

afterEach(() => vi.unstubAllEnvs());

const noSettings = { getShellPath: () => undefined, getShellCommandPrefix: () => undefined };

describe("packaged shell", () => {
  it("leaves source installations and platforms without a private shell unchanged", () => {
    const registerTool = vi.fn();
    const settings = SettingsManager.inMemory();
    vi.stubEnv("KADY_BASH_PATH", "/unused/private/bash");
    vi.stubEnv("KADY_PACKAGED", "0");
    registerPackagedShell({ registerTool }, noSettings);
    applyPackagedShell(settings);
    vi.stubEnv("KADY_PACKAGED", "1");
    vi.stubEnv("KADY_BASH_PATH", "");
    registerPackagedShell({ registerTool }, noSettings);
    applyPackagedShell(settings);
    expect(registerTool).not.toHaveBeenCalled();
    expect(settings.getShellPath()).toBeUndefined();
  });

  it("points lead sessions at the private shell through Pi's own setting", () => {
    vi.stubEnv("KADY_PACKAGED", "1");
    vi.stubEnv("KADY_BASH_PATH", "/private/bash");
    const settings = SettingsManager.inMemory({ shellCommandPrefix: "set -euo pipefail" });
    applyPackagedShell(settings);
    expect(settings.getShellPath()).toBe("/private/bash");
    expect(settings.getShellCommandPrefix()).toBe("set -euo pipefail");
  });

  it("keeps a shellPath the user configured", () => {
    vi.stubEnv("KADY_PACKAGED", "1");
    vi.stubEnv("KADY_BASH_PATH", "/private/bash");
    const settings = SettingsManager.inMemory({ shellPath: "/user/bash" });
    applyPackagedShell(settings);
    expect(settings.getShellPath()).toBe("/user/bash");
    const registerTool = vi.fn();
    registerPackagedShell({ registerTool }, settings);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("executes the explicit shell in a path with spaces and Unicode, with the settings prefix", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kady shell ü "));
    try {
      const shellPath = path.join(directory, "private bash");
      await fs.writeFile(shellPath, '#!/bin/sh\nprintf "private-shell\\n"\nexec /bin/bash "$@"\n', { mode: 0o755 });
      vi.stubEnv("KADY_PACKAGED", "1");
      vi.stubEnv("KADY_BASH_PATH", shellPath);
      let tool: ToolDefinition | undefined;
      const settings = { getShellPath: () => undefined, getShellCommandPrefix: () => "printf 'prefix-ran\\n'" };
      registerPackagedShell({ registerTool: ((definition: ToolDefinition) => { tool = definition; }) as ExtensionAPI["registerTool"] }, settings);
      expect(tool?.name).toBe("bash");
      const context = { cwd: directory, sessionManager: { getSessionId: () => "packaged-shell-test", getSessionFile: () => undefined } };
      const result = await tool!.execute("shell-test", { command: "printf 'command-ran\\n'" }, undefined, undefined, context as Parameters<ToolDefinition["execute"]>[4]);
      expect(result.content).toEqual([{ type: "text", text: "private-shell\nprefix-ran\ncommand-ran\n" }]);
      expect(result.isError).not.toBe(true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
