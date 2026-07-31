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
  listSkillsWithProblems,
  readSkillSource,
  seedProjectSkills,
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
  it("seeds package skills disabled while keeping borderline workflows enabled", async () => {
    ensureProjectExists("source");
    const source = resolvePaths("source");
    for (const name of [
      "scanpy",
      "openpiv",
      "modal",
      "hypogenic",
      "diffdock",
      "liteparse",
      "molecular-dynamics",
      "optimize-for-gpu",
      "rowan",
    ]) {
      makeSkill(source.skillsDir, name, `${name} description`);
    }

    ensureProjectExists("target");
    const target = resolvePaths("target");
    expect(await seedProjectSkills(target, false)).toBe(9);
    expect(listDisabledSkills(target).map((s) => s.name).sort()).toEqual([
      "hypogenic",
      "modal",
      "openpiv",
      "scanpy",
    ]);
    expect(listProjectSkills(target).map((s) => s.name).sort()).toEqual([
      "diffdock",
      "liteparse",
      "molecular-dynamics",
      "optimize-for-gpu",
      "rowan",
    ]);
  });

  it("migrates existing package skills once without overriding later user choices", async () => {
    ensureProjectExists("existing");
    const paths = resolvePaths("existing");
    makeSkill(paths.skillsDir, "scanpy", "single-cell package");
    makeSkill(paths.skillsDir, "literature-review", "review workflow");

    expect(await seedProjectSkills(paths, false)).toBe(2);
    expect(listDisabledSkills(paths).map((s) => s.name)).toContain("scanpy");
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("literature-review");

    expect(enableSkill(paths, "scanpy")).toEqual({ ok: true });
    expect(await seedProjectSkills(paths, false)).toBe(2);
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("scanpy");
  });

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

  it("reports an unparseable SKILL.md instead of silently dropping it", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    makeSkill(paths.skillsDir, "good", "fine");
    // An unquoted plain scalar containing ": " — YAML reads it as a nested
    // mapping and the whole skill fails to load.
    makeSkill(paths.skillsDir, "broken", "a hosted server (public demo): promoter regions");

    const { enabled, problems } = listSkillsWithProblems(paths);
    expect(enabled.map((s) => s.name)).toEqual(["good"]);
    const broken = problems.find((p) => p.name === "broken");
    expect(broken).toMatchObject({ name: "broken", state: "enabled", loaded: false });
    expect(broken?.message).toBeTruthy();

    // Quoting the description makes it load, and the problem goes away.
    const file = path.join(paths.skillsDir, "broken", "SKILL.md");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf-8").replace(/^description: (.*)$/m, 'description: "$1"'),
      "utf-8",
    );
    const after = listSkillsWithProblems(paths);
    expect(after.enabled.map((s) => s.name).sort()).toEqual(["broken", "good"]);
    expect(after.problems).toEqual([]);
  });

  it("400 on bad name, 404 when the skill is not in the source location", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    expect(disableSkill(paths, "../evil")).toMatchObject({ ok: false, status: 400 });
    expect(disableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
    expect(enableSkill(paths, "nope")).toMatchObject({ ok: false, status: 404 });
  });
});
