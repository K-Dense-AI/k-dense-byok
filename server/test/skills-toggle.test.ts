import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  disableSkill,
  enableSkill,
  listDisabledSkills,
  listProjectSkills,
  readSkillSource,
} from "../src/agent/skills.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
function makeSkill(dir: string, name: string, desc: string): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody for ${name}.\n`,
    "utf-8",
  );
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("skills enable/disable", () => {
  it("round-trips a skill between enabled and disabled, preserving content", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    makeSkill(paths.skillsDir, "scanpy-analysis", "single cell");

    expect(listProjectSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");

    expect(disableSkill(paths, "scanpy-analysis")).toEqual({ ok: true });
    expect(listProjectSkills(paths).map((s) => s.name)).not.toContain("scanpy-analysis");
    expect(listDisabledSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");
    // content preserved and readable from either location
    expect(readSkillSource(paths, "scanpy-analysis")).toContain("Body for scanpy-analysis.");

    expect(enableSkill(paths, "scanpy-analysis")).toEqual({ ok: true });
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("scanpy-analysis");
    expect(listDisabledSkills(paths)).toEqual([]);
  });

  it("400 on bad name, 404 when the skill is not in the source location", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    expect(disableSkill(paths, "../evil")).toMatchObject({ ok: false, status: 400 });
    expect(disableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
    expect(enableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
  });
});
