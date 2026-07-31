/**
 * User-driven skill management, exercised against local-path sources so the
 * real `skills` CLI runs without network access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { KADY_PI_AGENT_DIR, KADY_SKILLS_CACHE_DIR, PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, type ProjectPaths } from "../src/projects.ts";
import {
  disableSkill,
  globalSkillRoot,
  listDisabledSkills,
  listProjectSkills,
  projectSkillRoot,
  readSkillSource,
  skillsDisabledDir,
} from "../src/agent/skills.ts";
import {
  getSkillProvenance,
  getSkillSyncStatus,
  syncProjectSkillsFromCatalogue,
} from "../src/agent/skills-sync.ts";
import {
  checkSkillUpdate,
  createSkill,
  installStagedSkills,
  previewSkillSource,
  removeSkill,
  SkillOperationFailure,
  updateSkillFromSource,
  writeSkillSource,
} from "../src/agent/skills-install.ts";

let sourceRoot: string;
let paths: ProjectPaths;

function writeSourceSkill(name: string, body: string, description = `${name} skill`): void {
  const dir = path.join(sourceRoot, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf-8",
  );
}

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(KADY_SKILLS_CACHE_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "skills"), { recursive: true, force: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "kady-skills"), { recursive: true, force: true });
  sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-skill-source-"));
  writeSourceSkill("alpha-skill", "alpha v1");
  writeSourceSkill("beta-skill", "beta v1");
  paths = ensureProjectExists("install-project");
}

beforeEach(reset);
afterAll(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.rmSync(KADY_SKILLS_CACHE_DIR, { recursive: true, force: true });
});

const ack = { acknowledged: true } as const;

describe("installing skills from a source", () => {
  it("previews what a source holds without installing anything", async () => {
    const preview = await previewSkillSource(paths, { source: sourceRoot });
    expect(preview.skills.map((s) => s.name).sort()).toEqual([
      "alpha-skill",
      "beta-skill",
    ]);
    expect(preview.skills[0].description).toContain("skill");
    expect(preview.skills.every((s) => !s.installed)).toBe(true);
    expect(listProjectSkills(paths)).toHaveLength(0);
  });

  it("refuses to install without the permissions acknowledgement", async () => {
    // The gate lives on the server, not only in the dialog: an install is the
    // moment third-party instructions enter the agent.
    await expect(
      installStagedSkills(paths, { source: sourceRoot, names: ["alpha-skill"] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(listProjectSkills(paths)).toHaveLength(0);
  });

  it("installs the chosen subset, enabled, with recorded provenance", async () => {
    await previewSkillSource(paths, { source: sourceRoot });
    const result = await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    expect(result).toEqual({ installed: ["alpha-skill"], conflicts: [] });
    expect(listProjectSkills(paths).map((s) => s.name)).toEqual(["alpha-skill"]);
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v1");
    expect(getSkillProvenance(paths, "alpha-skill")).toMatchObject({
      origin: "registry",
      source: sourceRoot,
    });
  });

  it("installs without a prior preview by fetching on demand", async () => {
    // A confirmed install must not fail just because the staging cache is cold.
    const result = await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["beta-skill"],
      ...ack,
    });
    expect(result.installed).toEqual(["beta-skill"]);
  });

  it("reports a name clash instead of overwriting, and replaces when told to", async () => {
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    // Disable it so we can prove placement survives a replacement.
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("alpha-skill");
    expect(disableSkill(paths, "alpha-skill")).toEqual({ ok: true });

    writeSourceSkill("alpha-skill", "alpha v2");
    const blocked = await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    expect(blocked).toEqual({ installed: [], conflicts: ["alpha-skill"] });
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v1");

    const replaced = await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      replace: true,
      ...ack,
    });
    expect(replaced.installed).toEqual(["alpha-skill"]);
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v2");
    // Still disabled: replacing content must not silently re-enable a skill.
    expect(listDisabledSkills(paths).map((s) => s.name)).toContain("alpha-skill");
    expect(fs.existsSync(path.join(skillsDisabledDir(paths), "alpha-skill"))).toBe(true);
  });

  it("installs the reviewed bytes with a valid token, and refetches without one", async () => {
    const preview = await previewSkillSource(paths, { source: sourceRoot });
    writeSourceSkill("alpha-skill", "alpha v2");

    // With the confirmed token, the user gets exactly what they reviewed —
    // installing something they never saw would defeat the confirmation step.
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      stagingToken: preview.stagingToken,
      ...ack,
    });
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v1");

    // An install that reviewed nothing has no claim on the cache, so the source
    // is fetched again rather than serving whatever was left behind.
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      replace: true,
      ...ack,
    });
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v2");
  });

  it("rejects a name the source does not offer", async () => {
    await expect(
      installStagedSkills(paths, { source: sourceRoot, names: ["nope"], ...ack }),
    ).rejects.toBeInstanceOf(SkillOperationFailure);
  });

  it("installs into the user-level scope, visible to every project", async () => {
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["beta-skill"],
      scope: "global",
      ...ack,
    });
    const global = globalSkillRoot();
    expect(listProjectSkills(global).map((s) => s.name)).toEqual(["beta-skill"]);
    expect(
      fs.existsSync(path.join(KADY_PI_AGENT_DIR, "skills", "beta-skill", "SKILL.md")),
    ).toBe(true);
    // The project scope is untouched by a global install.
    expect(listProjectSkills(paths)).toHaveLength(0);

    // A second project sees it without doing anything.
    const other = ensureProjectExists("second-project");
    expect(listProjectSkills(projectSkillRoot(other))).toHaveLength(0);
    expect(listProjectSkills(globalSkillRoot()).map((s) => s.name)).toEqual([
      "beta-skill",
    ]);
  });
});

describe("authoring and editing skills", () => {
  it("creates a skill from a template and records it as local", () => {
    const created = createSkill(paths, {
      name: "my-workflow",
      description: "Run our lab's QC workflow",
    });
    expect(created).toEqual({ name: "my-workflow", scope: "project" });
    const source = readSkillSource(paths, "my-workflow");
    expect(source).toContain("name: my-workflow");
    expect(source).toContain("Run our lab's QC workflow");
    expect(listProjectSkills(paths).map((s) => s.name)).toEqual(["my-workflow"]);
    expect(getSkillProvenance(paths, "my-workflow")?.origin).toBe("local");
  });

  it("enforces Pi's stricter name rules and rejects duplicates", () => {
    for (const bad of ["Bad Name", "double--hyphen", "-leading", "trailing-", "under_score"]) {
      expect(() => createSkill(paths, { name: bad })).toThrow(/Invalid skill name/);
    }
    createSkill(paths, { name: "taken" });
    expect(() => createSkill(paths, { name: "taken" })).toThrow(/already exists/);
  });

  it("saves edited SKILL.md content", () => {
    createSkill(paths, { name: "editable" });
    const edited = "---\nname: editable\ndescription: Edited by hand\n---\n\nNew body.\n";
    writeSkillSource(paths, "editable", edited);
    expect(readSkillSource(paths, "editable")).toBe(edited);
    expect(listProjectSkills(paths)[0].description).toBe("Edited by hand");
  });

  it("refuses to write an unknown skill or empty content", () => {
    createSkill(paths, { name: "present" });
    expect(() => writeSkillSource(paths, "absent", "x")).toThrow(/No such skill/);
    expect(() => writeSkillSource(paths, "present", "   ")).toThrow(/required/);
  });
});

describe("removing skills", () => {
  it("deletes a user-installed skill outright", async () => {
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    expect(removeSkill(paths, "alpha-skill")).toEqual({
      name: "alpha-skill",
      disposition: "deleted",
    });
    expect(listProjectSkills(paths)).toHaveLength(0);
    expect(getSkillProvenance(paths, "alpha-skill")).toBeNull();
  });

  it("archives a catalogue skill and stops the sync from restoring it", () => {
    const catalogue = path.join(PROJECTS_ROOT, "catalogue-src");
    for (const name of ["cat-one", "cat-two"]) {
      const dir = path.join(catalogue, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`,
        "utf-8",
      );
    }
    syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(listProjectSkills(paths).map((s) => s.name).sort()).toEqual([
      "cat-one",
      "cat-two",
    ]);

    expect(removeSkill(paths, "cat-one")).toEqual({
      name: "cat-one",
      disposition: "archived",
    });
    expect(
      fs.existsSync(path.join(paths.sandbox, ".pi", "skills-archived", "cat-one")),
    ).toBe(true);
    expect(getSkillSyncStatus(paths).removed).toEqual(["cat-one"]);

    syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(listProjectSkills(paths).map((s) => s.name)).toEqual(["cat-two"]);
  });

  it("removes a disabled skill too", () => {
    createSkill(paths, { name: "temp-skill" });
    expect(disableSkill(paths, "temp-skill")).toEqual({ ok: true });
    expect(removeSkill(paths, "temp-skill").disposition).toBe("deleted");
    expect(fs.existsSync(path.join(skillsDisabledDir(paths), "temp-skill"))).toBe(false);
  });

  it("404s on an unknown skill", () => {
    expect(() => removeSkill(paths, "missing")).toThrow(/No such skill/);
  });
});

describe("update checks for user-installed skills", () => {
  it("detects a changed source only after it changes, then applies it", async () => {
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    expect(await checkSkillUpdate(paths, "alpha-skill")).toMatchObject({
      updateAvailable: false,
    });
    expect(getSkillSyncStatus(paths).updatesAvailable).not.toContain("alpha-skill");

    writeSourceSkill("alpha-skill", "alpha v2");
    expect(await checkSkillUpdate(paths, "alpha-skill")).toMatchObject({
      updateAvailable: true,
    });
    expect(getSkillSyncStatus(paths).updatesAvailable).toContain("alpha-skill");
    // Checking must not change the installed copy — that needs an explicit update.
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v1");

    await updateSkillFromSource(paths, "alpha-skill");
    expect(readSkillSource(paths, "alpha-skill")).toContain("alpha v2");
    expect(getSkillSyncStatus(paths).updatesAvailable).not.toContain("alpha-skill");
  });

  it("treats a locally edited copy as needing an update, not as up to date", async () => {
    await installStagedSkills(paths, {
      source: sourceRoot,
      names: ["alpha-skill"],
      ...ack,
    });
    fs.appendFileSync(
      path.join(paths.skillsDir, "alpha-skill", "SKILL.md"),
      "\nLocal note.\n",
    );
    expect(await checkSkillUpdate(paths, "alpha-skill")).toMatchObject({
      updateAvailable: true,
    });
  });

  it("has nothing to check for a locally authored skill", async () => {
    createSkill(paths, { name: "home-grown" });
    await expect(checkSkillUpdate(paths, "home-grown")).rejects.toMatchObject({
      status: 400,
    });
  });
});
