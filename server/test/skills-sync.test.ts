import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  getSkillOrigins,
  getSkillProvenance,
  getSkillSyncStatus,
  markSkillRemoved,
  recordSkillOrigin,
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

  it("identifies a catalogue by content digest when there is no commit id", () => {
    const paths = ensureProjectExists("digest-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "alpha", "v1");

    // The CLI stages file copies, so callers pass a null commit.
    const first = syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(first.upstreamCommit).toBeNull();
    expect(first.catalogueDigest).toMatch(/^[0-9a-f]{64}$/);

    const unchanged = syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(unchanged.catalogueDigest).toBe(first.catalogueDigest);

    writeSkill(catalogue, "alpha", "v2");
    const changed = syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(changed.catalogueDigest).not.toBe(first.catalogueDigest);
  });

  it("keeps honouring a removed catalogue skill instead of reinstalling it", () => {
    const paths = ensureProjectExists("removed-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "unwanted", "v1");
    writeSkill(catalogue, "wanted", "v1");
    syncProjectSkillsFromCatalogue(paths, catalogue, null);

    fs.rmSync(path.join(paths.skillsDir, "unwanted"), { recursive: true, force: true });
    markSkillRemoved(paths, "unwanted");

    const after = syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(fs.existsSync(path.join(paths.skillsDir, "unwanted"))).toBe(false);
    expect(after.removed).toEqual(["unwanted"]);
    expect(after.counts.added).toBe(0);
    // The rest of the catalogue is unaffected by the tombstone.
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("wanted");

    // Taking the upstream copy again is an explicit undelete.
    const restored = replaceProjectSkillFromCatalogue(paths, "unwanted", catalogue, null);
    expect(restored.removed).not.toContain("unwanted");
    expect(fs.existsSync(path.join(paths.skillsDir, "unwanted", "SKILL.md"))).toBe(true);
  });

  it("leaves user-installed skills alone even when the catalogue offers the name", () => {
    const paths = ensureProjectExists("origin-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "shared-name", "catalogue-copy");
    writeSkill(catalogue, "plain", "v1");
    syncProjectSkillsFromCatalogue(paths, catalogue, null);

    // The user replaces that skill with their own from another source.
    writeSkill(paths.skillsDir, "shared-name", "user-copy");
    recordSkillOrigin(paths, "shared-name", {
      origin: "registry",
      source: "someone/their-skills",
    });

    const after = syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(skillBody(paths.skillsDir, "shared-name")).toContain("user-copy");
    expect(after.updatesAvailable).not.toContain("shared-name");
    expect(getSkillProvenance(paths, "shared-name")).toMatchObject({
      origin: "registry",
      source: "someone/their-skills",
    });

    // A user skill absent from the catalogue is never archived as retired.
    writeSkill(paths.skillsDir, "only-mine", "v1");
    recordSkillOrigin(paths, "only-mine", { origin: "local" });
    syncProjectSkillsFromCatalogue(paths, catalogue, null);
    expect(fs.existsSync(path.join(paths.skillsDir, "only-mine", "SKILL.md"))).toBe(true);
    expect(getSkillOrigins(paths)["only-mine"]).toBe("local");
    expect(getSkillOrigins(paths).plain).toBe("catalogue");
  });

  it("migrates a v1 manifest rather than discarding its baselines", () => {
    const paths = ensureProjectExists("migrate-project");
    const catalogue = path.join(PROJECTS_ROOT, "catalogue");
    writeSkill(catalogue, "edited", "v1");
    syncProjectSkillsFromCatalogue(paths, catalogue, "commit-1");

    // Rewrite the manifest as the v1 shape a pre-upgrade install would hold.
    const manifestFile = path.join(paths.kadyDir, "skills-sync.json");
    const v1 = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    const baseHash = v1.skills.edited.baseHash;
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        version: 1,
        repo: v1.repo,
        branch: v1.branch,
        upstreamCommit: "commit-1",
        lastCheckedAt: v1.lastCheckedAt,
        skills: { edited: { baseHash, upstreamHash: baseHash } },
        updatesAvailable: [],
        customized: [],
        orphaned: [],
        archived: [],
      }),
      "utf-8",
    );

    // The baseline survives, so an unchanged catalogue still reads as clean and
    // a genuine upstream change updates in place rather than being preserved as
    // if the user had edited it.
    expect(syncProjectSkillsFromCatalogue(paths, catalogue, null).counts).toMatchObject({
      unchanged: 1,
      preserved: 0,
    });
    writeSkill(catalogue, "edited", "v2");
    expect(syncProjectSkillsFromCatalogue(paths, catalogue, null).counts).toMatchObject({
      updated: 1,
      preserved: 0,
    });
  });
});
