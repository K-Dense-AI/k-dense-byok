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

  it("shadow case: a project agent named like a builtin toggles both the file and the override, with no duplicate row", () => {
    ensureProjectExists("p4");
    const paths = resolvePaths("p4");
    const builtin = listBuiltinAgents()[0];
    expect(builtin).toBeTruthy();
    const builtinName = builtin.name;

    // Project agent shadows the builtin of the same name.
    writeProjectAgent(paths, builtinName, {
      description: "shadow of a builtin",
      systemPrompt: "Shadowing.",
    });

    const shadowed = listAgents(paths).filter((a) => a.name === builtinName);
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].enabled).toBe(true);

    // Disable: must relocate the project file AND set the builtin override,
    // since pi-subagents only discovers project agents from .pi/agents/ and
    // would otherwise "un-shadow" and re-activate the builtin.
    expect(setSpecialistEnabled(paths, builtinName, false)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", `${builtinName}.md`))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", `${builtinName}.md`))).toBe(true);
    const settingsAfterDisable = readPiSettings(paths) as any;
    expect(settingsAfterDisable.subagents.agentOverrides[builtinName].disabled).toBe(true);
    const afterDisable = listAgents(paths).filter((a) => a.name === builtinName);
    expect(afterDisable).toHaveLength(1);
    expect(afterDisable[0].enabled).toBe(false);

    // Re-enable: relocate back and clear the override.
    expect(setSpecialistEnabled(paths, builtinName, true)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", `${builtinName}.md`))).toBe(true);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", `${builtinName}.md`))).toBe(false);
    const settingsAfterEnable = readPiSettings(paths) as any;
    expect(settingsAfterEnable.subagents.agentOverrides[builtinName].disabled).toBe(false);
    const afterEnable = listAgents(paths).filter((a) => a.name === builtinName);
    expect(afterEnable).toHaveLength(1);
    expect(afterEnable[0].enabled).toBe(true);
  });

  it("404 for an unknown name, 400 for a bad name", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    expect(setSpecialistEnabled(paths, "does-not-exist", false)).toMatchObject({ ok: false, status: 404 });
    expect(setSpecialistEnabled(paths, "Bad Name", false)).toMatchObject({ ok: false, status: 400 });
  });
});
