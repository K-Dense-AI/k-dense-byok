import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPackagedShell } from "../src/agent/packaged-shell.ts";

afterEach(() => vi.unstubAllEnvs());

describe("packaged shell", () => {
  it("leaves source installations and platforms without a private shell unchanged", () => {
    const registerTool = vi.fn();
    vi.stubEnv("KADY_BASH_PATH", "/unused/private/bash");
    vi.stubEnv("KADY_PACKAGED", "0");
    registerPackagedShell({ registerTool });
    vi.stubEnv("KADY_PACKAGED", "1");
    vi.stubEnv("KADY_BASH_PATH", "");
    registerPackagedShell({ registerTool });
    expect(registerTool).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("executes the explicit shell in a path with spaces and Unicode", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kady shell ü "));
    try {
      const shellPath = path.join(directory, "private bash");
      await fs.writeFile(shellPath, '#!/bin/sh\nprintf "private-shell\\n"\nexec /bin/bash "$@"\n', { mode: 0o755 });
      vi.stubEnv("KADY_PACKAGED", "1");
      vi.stubEnv("KADY_BASH_PATH", shellPath);
      let tool: ToolDefinition | undefined;
      registerPackagedShell({ registerTool: ((definition: ToolDefinition) => { tool = definition; }) as ExtensionAPI["registerTool"] });
      expect(tool?.name).toBe("bash");
      const context = { cwd: directory, sessionManager: { getSessionId: () => "packaged-shell-test", getSessionFile: () => undefined } };
      const result = await tool!.execute("shell-test", { command: "printf 'command-ran\\n'" }, undefined, undefined, context as Parameters<ToolDefinition["execute"]>[4]);
      expect(result.content).toEqual([{ type: "text", text: "private-shell\ncommand-ran\n" }]);
      expect(result.isError).not.toBe(true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
