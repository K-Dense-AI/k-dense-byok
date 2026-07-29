import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  getSkillSyncStatus,
  replaceProjectSkillFromCatalogue,
  syncProjectSkillsFromCatalogue,
} from "../src/agent/skills-sync.ts";
import {
  enableSkill,
  listDisabledSkills,
  listProjectSkills,
  skillsDisabledDir,
} from "../src/agent/skills.ts";
import { ensureProjectExists } from "../src/projects.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function writeSkill(base: string, name: string, version: string): void {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} ${version}\n---\n\n${version}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "payload.txt"), `${version}\n`, "utf-8");
}

function skillBody(base: string, name: string): string {
  return fs.readFileSync(path.join(base, name, "SKILL.md"), "utf-8");
}

beforeEach(reset);
afterAll(reset);

describe("skill catalogue synchronization", () => {
  it("updates clean skills, preserves edits and state, and archives clean removals", () => {
    const paths = ensureProjectExists("sync-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "openpiv", "v1");
    writeSkill(catalogue, "literature-review", "v1");
    writeSkill(catalogue, "retired-clean", "v1");
    writeSkill(catalogue, "retired-custom", "v1");

    const first = syncProjectSkillsFromCatalogue(paths, catalogue, "commit-1");
    expect(first.counts).toMatchObject({ added: 4, updated: 0, archived: 0 });
    expect(listDisabledSkills(paths).map((skill) => skill.name)).toContain("openpiv");
    expect(listProjectSkills(paths).map((skill) => skill.name)).toContain(
      "literature-review",
    );

    // A user toggle and a user edit must both survive the next catalogue sync.
    expect(enableSkill(paths, "openpiv")).toEqual({ ok: true });
    fs.appendFileSync(
      path.join(paths.skillsDir, "literature-review", "SKILL.md"),
      "\nLocal guidance.\n",
    );
    fs.appendFileSync(
      path.join(paths.skillsDir, "retired-custom", "SKILL.md"),
      "\nLocal guidance.\n",
    );
    writeSkill(paths.skillsDir, "project-only", "custom");

    fs.rmSync(catalogue, { recursive: true, force: true });
    writeSkill(catalogue, "openpiv", "v2");
    writeSkill(catalogue, "literature-review", "v2");
    writeSkill(catalogue, "paperclip", "v1");

    const second = syncProjectSkillsFromCatalogue(paths, catalogue, "commit-2");
    expect(second.counts).toMatchObject({
      added: 1,
      updated: 1,
      preserved: 2,
      archived: 1,
    });
    expect(skillBody(paths.skillsDir, "openpiv")).toContain("v2");
    expect(fs.existsSync(path.join(skillsDisabledDir(paths), "openpiv"))).toBe(false);
    expect(skillBody(paths.skillsDir, "literature-review")).toContain("Local guidance.");
    expect(second.updatesAvailable).toContain("literature-review");
    expect(second.customized).toEqual(
      expect.arrayContaining(["literature-review", "project-only", "retired-custom"]),
    );
    expect(second.orphaned).toEqual(["retired-custom"]);
    expect(fs.existsSync(path.join(paths.skillsDir, "retired-clean"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(paths.sandbox, ".pi", "skills-archived", "retired-clean", "SKILL.md"),
      ),
    ).toBe(true);
    expect(listProjectSkills(paths).map((skill) => skill.name)).toContain("paperclip");

    const replaced = replaceProjectSkillFromCatalogue(
      paths,
      "literature-review",
      catalogue,
      "commit-2",
    );
    expect(skillBody(paths.skillsDir, "literature-review")).toContain("v2");
    expect(skillBody(paths.skillsDir, "literature-review")).not.toContain(
      "Local guidance.",
    );
    expect(replaced.updatesAvailable).not.toContain("literature-review");
    expect(replaced.customized).not.toContain("literature-review");
  });

  it("baselines exact legacy copies but does not overwrite untracked differences", () => {
    const paths = ensureProjectExists("legacy-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "exact", "current");
    writeSkill(catalogue, "different", "current");
    writeSkill(paths.skillsDir, "exact", "current");
    writeSkill(paths.skillsDir, "different", "old-or-custom");

    const result = syncProjectSkillsFromCatalogue(paths, catalogue, "commit-1");

    expect(result.counts.unchanged).toBe(1);
    expect(result.counts.preserved).toBe(1);
    expect(result.updatesAvailable).toEqual(["different"]);
    expect(skillBody(paths.skillsDir, "different")).toContain("old-or-custom");
    expect(getSkillSyncStatus(paths).upstreamCommit).toBe("commit-1");
  });
});
