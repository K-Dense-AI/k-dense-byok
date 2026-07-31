/**
 * The `skills` CLI is exercised for real, but only against **local-path
 * sources**, so the suite needs no network. A local source is a first-class
 * source format for the CLI, and the staged output is identical in shape to a
 * GitHub fetch — which is the property the rest of the skill pipeline depends
 * on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KADY_SKILLS_CACHE_DIR } from "../src/config.ts";
import {
  cacheKeyForSource,
  clearStaging,
  fetchSkills,
  resolveSkillsCli,
  stagedSkillsDir,
} from "../src/agent/skills-fetch.ts";

let fixtureRoot: string;

/** A source repo laid out the way the CLI discovers skills: `skills/<name>/`. */
function writeFixtureSkill(name: string, description: string, extras: string[] = []): void {
  const dir = path.join(fixtureRoot, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`,
    "utf-8",
  );
  for (const extra of extras) {
    const file = path.join(dir, extra);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${extra} contents\n`, "utf-8");
  }
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-skills-fixture-"));
  writeFixtureSkill("alpha-skill", "First fixture skill", [
    "references/notes.md",
    "scripts/run.py",
  ]);
  writeFixtureSkill("beta-skill", "Second fixture skill");
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(KADY_SKILLS_CACHE_DIR, { recursive: true, force: true });
});

describe("skills CLI fetcher", () => {
  it("resolves the bundled CLI entry point", () => {
    const cli = resolveSkillsCli();
    expect(cli).toBeTruthy();
    expect(fs.existsSync(cli as string)).toBe(true);
  });

  it("stages every skill of a source, with multi-file trees intact", async () => {
    const cacheKey = cacheKeyForSource(fixtureRoot);
    const result = await fetchSkills({ source: fixtureRoot, cacheKey });

    expect(result.skillsDir).toBe(stagedSkillsDir(result.stagingDir));
    expect(
      fs.readdirSync(result.skillsDir, { withFileTypes: true }).map((e) => e.name).sort(),
    ).toEqual(["alpha-skill", "beta-skill"]);

    // A skill is a tree, not just its SKILL.md: supporting files must survive
    // the fetch or every catalogue skill with references/ would arrive broken.
    const alpha = path.join(result.skillsDir, "alpha-skill");
    expect(fs.existsSync(path.join(alpha, "references", "notes.md"))).toBe(true);
    expect(fs.existsSync(path.join(alpha, "scripts", "run.py"))).toBe(true);

    // The staged copy must be byte-identical to the source, because the sync
    // engine treats any difference as a local edit.
    expect(fs.readFileSync(path.join(alpha, "SKILL.md"), "utf-8")).toBe(
      fs.readFileSync(
        path.join(fixtureRoot, "skills", "alpha-skill", "SKILL.md"),
        "utf-8",
      ),
    );
  });

  it("records per-skill provenance in the lock file", async () => {
    const cacheKey = cacheKeyForSource(fixtureRoot);
    const { lock } = await fetchSkills({ source: fixtureRoot, cacheKey });
    expect(Object.keys(lock).sort()).toEqual(["alpha-skill", "beta-skill"]);
    expect(lock["alpha-skill"]?.sourceType).toBe("local");
    expect(lock["alpha-skill"]?.source).toContain(path.basename(fixtureRoot));
  });

  it("fetches a named subset only", async () => {
    const cacheKey = cacheKeyForSource(`${fixtureRoot}#subset`);
    const { skillsDir } = await fetchSkills({
      source: fixtureRoot,
      names: ["beta-skill"],
      cacheKey,
    });
    expect(fs.readdirSync(skillsDir)).toEqual(["beta-skill"]);
  });

  it("rejects a name the source does not have, with the CLI's own message", async () => {
    const cacheKey = cacheKeyForSource(`${fixtureRoot}#missing`);
    await expect(
      fetchSkills({ source: fixtureRoot, names: ["nope"], cacheKey }),
    ).rejects.toThrow(/No matching skills found/i);
  });

  it("surfaces a readable failure instead of the CLI's progress animation", async () => {
    // The CLI redraws one spinner line per frame; with the cursor codes gone
    // those frames survive as near-duplicate fragments that would bury the
    // sentence explaining the failure.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kady-empty-source-"));
    try {
      const cacheKey = cacheKeyForSource(empty);
      const error = await fetchSkills({ source: empty, cacheKey }).catch(
        (err: Error) => err,
      );
      const message = (error as Error).message;
      expect(message).toMatch(/no valid skills found/i);
      expect(message.split("\n").length).toBeLessThanOrEqual(6);
      expect(message).not.toMatch(/Fetching skills/);
      expect(message).not.toMatch(/Agent detected/i);
      // The path the user just typed is not a diagnosis.
      expect(message).not.toMatch(/^Source:/im);
      // No box art, spinner frames or column separators.
      expect(message).not.toMatch(new RegExp("[\\u2500-\\u27bf|]"));
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails clearly when the source does not exist", async () => {
    const missing = path.join(fixtureRoot, "does-not-exist");
    const cacheKey = cacheKeyForSource(missing);
    await expect(fetchSkills({ source: missing, cacheKey })).rejects.toThrow();
  });

  it("re-fetching the same key replaces the staged tree", async () => {
    const cacheKey = cacheKeyForSource(`${fixtureRoot}#replace`);
    await fetchSkills({ source: fixtureRoot, cacheKey });
    const { skillsDir } = await fetchSkills({
      source: fixtureRoot,
      names: ["alpha-skill"],
      cacheKey,
    });
    // Stale skills from the previous fetch must not linger in staging.
    expect(fs.readdirSync(skillsDir)).toEqual(["alpha-skill"]);
    clearStaging(cacheKey);
    expect(fs.existsSync(skillsDir)).toBe(false);
  });
});
