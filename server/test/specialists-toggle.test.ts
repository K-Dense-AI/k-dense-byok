import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  listAgents,
  listBuiltinAgents,
  setSpecialistEnabled,
  writeProjectAgent,
} from "../src/agent/agent-files.ts";
import { readPiSettings } from "../src/agent/capability-state.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("specialists enable/disable", () => {
  it("disables/enables a project specialist by relocating its file", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    writeProjectAgent(paths, "stats-reviewer", {
      description: "checks stats",
      systemPrompt: "Be rigorous.",
    });

    const before = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(before?.enabled).toBe(true);

    expect(setSpecialistEnabled(paths, "stats-reviewer", false)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "stats-reviewer.md"))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", "stats-reviewer.md"))).toBe(true);
    const disabled = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(disabled?.enabled).toBe(false);

    expect(setSpecialistEnabled(paths, "stats-reviewer", true)).toEqual({ ok: true });
    expect(listAgents(paths).find((a) => a.name === "stats-reviewer")?.enabled).toBe(true);
  });

  it("disables a builtin specialist via .pi/settings.json overrides", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    const builtin = listBuiltinAgents()[0];
    expect(builtin).toBeTruthy();

    expect(setSpecialistEnabled(paths, builtin.name, false)).toEqual({ ok: true });
    const settings = readPiSettings(paths) as any;
    expect(settings.subagents.agentOverrides[builtin.name].disabled).toBe(true);
    expect(listAgents(paths).find((a) => a.name === builtin.name)?.enabled).toBe(false);

    expect(setSpecialistEnabled(paths, builtin.name, true)).toEqual({ ok: true });
    expect(listAgents(paths).find((a) => a.name === builtin.name)?.enabled).toBe(true);
  });

  it("404 for an unknown name, 400 for a bad name", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    expect(setSpecialistEnabled(paths, "does-not-exist", false)).toMatchObject({ ok: false, status: 404 });
    expect(setSpecialistEnabled(paths, "Bad Name", false)).toMatchObject({ ok: false, status: 400 });
  });
});
