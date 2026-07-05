// server/test/capability-state.test.ts
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { resolvePaths } from "../src/projects.ts";
import { readPiSettings, writePiSettings, piSettingsPath } from "../src/agent/capability-state.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("pi settings read/write", () => {
  it("returns {} when missing and round-trips a nested write, preserving other keys", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    expect(readPiSettings(paths)).toEqual({});

    writePiSettings(paths, { packages: ["pi-web-access"], subagents: { agentOverrides: { oracle: { disabled: true } } } });
    const again = readPiSettings(paths);
    expect(again.packages).toEqual(["pi-web-access"]);
    expect((again.subagents as any).agentOverrides.oracle.disabled).toBe(true);
    expect(fs.existsSync(piSettingsPath(paths))).toBe(true);
  });
});
