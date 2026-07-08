import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { skillLabelForRead } from "../src/agent/skill-label.ts";
import { skillFieldFor } from "../src/agent/events.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
function makeSkill(dir: string, dirName: string, fmName: string): string {
  const d = path.join(dir, dirName);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, "SKILL.md");
  fs.writeFileSync(
    file,
    `---\nname: ${fmName}\ndescription: test skill\n---\n\nBody.\n`,
    "utf-8",
  );
  return file;
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("skillLabelForRead", () => {
  it("returns the frontmatter name, not the directory name", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    makeSkill(paths.skillsDir, "scrnaseq-qc-dir", "single-cell-qc");
    expect(skillLabelForRead(".pi/skills/scrnaseq-qc-dir/SKILL.md", paths.sandbox)).toBe(
      "single-cell-qc",
    );
  });

  it("resolves absolute paths too", () => {
    ensureProjectExists("p2");
    const paths = resolvePaths("p2");
    const file = makeSkill(paths.skillsDir, "foo", "fancy-foo");
    expect(skillLabelForRead(file, paths.sandbox)).toBe("fancy-foo");
  });

  it("falls back to the directory name when the file is gone", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    expect(skillLabelForRead(".pi/skills/vanished/SKILL.md", paths.sandbox)).toBe(
      "vanished",
    );
  });

  it("ignores non-skill reads", () => {
    ensureProjectExists("p4");
    const paths = resolvePaths("p4");
    expect(skillLabelForRead("analysis/results.md", paths.sandbox)).toBeNull();
    expect(skillLabelForRead(".pi/skills/foo/references/api.md", paths.sandbox)).toBeNull();
    expect(skillLabelForRead(undefined, paths.sandbox)).toBeNull();
  });
});

describe("skillFieldFor", () => {
  it("attaches the skill field only for read calls on skill files", () => {
    ensureProjectExists("p5");
    const paths = resolvePaths("p5");
    makeSkill(paths.skillsDir, "bar", "better-bar");
    expect(
      skillFieldFor("read", { path: ".pi/skills/bar/SKILL.md" }, paths.sandbox),
    ).toEqual({ skill: "better-bar" });
    expect(skillFieldFor("read", { path: "notes.md" }, paths.sandbox)).toBeUndefined();
    expect(
      skillFieldFor("bash", { command: "cat .pi/skills/bar/SKILL.md" }, paths.sandbox),
    ).toBeUndefined();
  });
});
