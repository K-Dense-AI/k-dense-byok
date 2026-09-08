import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isExternalCliAgent, listBuiltinAgents } from "../src/agent/agent-files.ts";
import { seedSubagentRuntimeSettings } from "../src/agent/subagent-runtime-settings.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

type Settings = {
  subagents?: {
    forceTopLevelAsync?: unknown;
    agentOverrides?: Record<string, { disabled?: unknown; tools?: unknown }>;
  };
  packages?: unknown;
};

function readSettings(sandbox: string): Settings {
  return JSON.parse(fs.readFileSync(path.join(sandbox, ".pi", "settings.json"), "utf-8")) as Settings;
}

const externalCli = listBuiltinAgents().filter(isExternalCliAgent).map((a) => a.name);
const piSessionBuiltins = listBuiltinAgents().filter((a) => !isExternalCliAgent(a)).map((a) => a.name);

describe("isExternalCliAgent", () => {
  it("recognises the packaged Claude Code / Codex / Cursor adapters and nothing else", () => {
    // pi-subagents ≥0.57 ships these six; the assertion pins the detection,
    // not the exact upstream roster.
    expect(externalCli).toEqual(
      expect.arrayContaining(["claude-code", "codex-exec", "cursor-agent"]),
    );
    expect(piSessionBuiltins).toEqual(
      expect.arrayContaining(["researcher", "reviewer", "scout", "worker"]),
    );
    expect(isExternalCliAgent({ extra: { type: "external-cli" } })).toBe(false);
    expect(isExternalCliAgent({ extra: { runner: "", type: "external-cli" } })).toBe(true);
    expect(isExternalCliAgent({})).toBe(false);
  });
});

describe("seedSubagentRuntimeSettings", () => {
  it("forces background launches and disables external-CLI builtins, once", () => {
    const paths = ensureProjectExists("default");
    expect(seedSubagentRuntimeSettings(paths)).toBe(true);
    const settings = readSettings(paths.sandbox);
    expect(settings.subagents?.forceTopLevelAsync).toBe(true);
    for (const name of externalCli) {
      expect(settings.subagents?.agentOverrides?.[name]?.disabled).toBe(true);
    }
    for (const name of piSessionBuiltins) {
      expect(settings.subagents?.agentOverrides?.[name]?.disabled).toBeUndefined();
    }
    expect(seedSubagentRuntimeSettings(paths)).toBe(false);
  });

  it("never overrides a value the user already set", () => {
    const paths = ensureProjectExists("default");
    const dir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(dir, { recursive: true });
    const [enabled, ...rest] = externalCli;
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        packages: ["keep-me"],
        subagents: {
          forceTopLevelAsync: false,
          agentOverrides: {
            [enabled]: { disabled: false, tools: ["read"] },
            researcher: { tools: ["read", "notebook"] },
          },
        },
      }),
    );
    expect(seedSubagentRuntimeSettings(paths)).toBe(true);
    const settings = readSettings(paths.sandbox);
    expect(settings.packages).toEqual(["keep-me"]);
    expect(settings.subagents?.forceTopLevelAsync).toBe(false);
    expect(settings.subagents?.agentOverrides?.[enabled]).toEqual({ disabled: false, tools: ["read"] });
    expect(settings.subagents?.agentOverrides?.researcher).toEqual({ tools: ["read", "notebook"] });
    for (const name of rest) {
      expect(settings.subagents?.agentOverrides?.[name]?.disabled).toBe(true);
    }
    expect(seedSubagentRuntimeSettings(paths)).toBe(false);
  });

  it("leaves an unparseable settings file alone", () => {
    const paths = ensureProjectExists("default");
    const dir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
    expect(seedSubagentRuntimeSettings(paths)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "settings.json"), "utf-8")).toBe("{ not json");
  });
});
