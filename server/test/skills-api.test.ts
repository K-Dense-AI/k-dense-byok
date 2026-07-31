/**
 * Route-level behaviour of the skill endpoints: scope resolution, the merged
 * picker list, and the guards that must not be bypassable from the client.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { KADY_PI_AGENT_DIR, PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { globalSkillRoot } from "../src/agent/skills.ts";
import { recordSkillOrigin } from "../src/agent/skills-sync.ts";

const app = await buildApp();

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    "utf-8",
  );
}

function clean(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "skills"), { recursive: true, force: true });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "skills-disabled"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(KADY_PI_AGENT_DIR, "kady-skills"), {
    recursive: true,
    force: true,
  });
}

beforeEach(clean);
afterAll(async () => {
  await app.close();
  clean();
});

const req = (method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    headers: { "x-project-id": "default" },
    ...(payload ? { payload } : {}),
  });

describe("skill scopes over HTTP", () => {
  it("merges both scopes for the composer picker, with the project winning", async () => {
    const paths = ensureProjectExists("default");
    const global = globalSkillRoot();
    writeSkill(paths.skillsDir, "project-only", "from the project");
    writeSkill(paths.skillsDir, "shared", "the project copy");
    writeSkill(global.skillsDir, "global-only", "from every project");
    writeSkill(global.skillsDir, "shared", "the global copy");

    const res = await req("GET", "/skills");
    expect(res.statusCode).toBe(200);
    const skills = res.json() as { name: string; description: string }[];
    expect(skills.map((s) => s.name)).toEqual([
      "global-only",
      "project-only",
      "shared",
    ]);
    // Pi resolves project skills first and collisions are first-wins, so the
    // picker must agree with what the agent will actually load.
    expect(skills.find((s) => s.name === "shared")?.description).toBe(
      "the project copy",
    );
  });

  it("lists one scope at a time when asked, and reports shadowing", async () => {
    const paths = ensureProjectExists("default");
    const global = globalSkillRoot();
    writeSkill(paths.skillsDir, "shared", "project copy");
    writeSkill(global.skillsDir, "shared", "global copy");
    writeSkill(global.skillsDir, "global-only", "global only");

    const project = (await req("GET", "/skills/all")).json() as {
      scope: string;
      enabled: { name: string }[];
      shadowed: string[];
    };
    expect(project.scope).toBe("project");
    expect(project.enabled.map((s) => s.name)).toEqual(["shared"]);

    const globalListing = (await req("GET", "/skills/all?scope=global")).json() as {
      scope: string;
      enabled: { name: string }[];
      shadowed: string[];
    };
    expect(globalListing.scope).toBe("global");
    expect(globalListing.enabled.map((s) => s.name).sort()).toEqual([
      "global-only",
      "shared",
    ]);
    expect(globalListing.shadowed).toEqual(["shared"]);
  });

  it("toggles and edits within the requested scope only", async () => {
    ensureProjectExists("default");
    const global = globalSkillRoot();
    writeSkill(global.skillsDir, "global-skill", "global");

    expect((await req("POST", "/skills/global-skill/disable")).statusCode).toBe(404);
    expect(
      (await req("POST", "/skills/global-skill/disable?scope=global")).statusCode,
    ).toBe(200);
    expect(
      fs.existsSync(path.join(global.disabledDir, "global-skill", "SKILL.md")),
    ).toBe(true);

    const edited = "---\nname: global-skill\ndescription: edited\n---\n\nnew body\n";
    expect(
      (
        await req("PUT", "/skills/global-skill/source?scope=global", {
          content: edited,
        })
      ).statusCode,
    ).toBe(200);
    const read = await req("GET", "/skills/global-skill/source?scope=global");
    expect((read.json() as { content: string }).content).toBe(edited);
  });
});

describe("skill install guards", () => {
  it("rejects an install that was never acknowledged", async () => {
    ensureProjectExists("default");
    const res = await req("POST", "/skills/install", {
      source: "someone/skills",
      names: ["whatever"],
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { detail: string }).detail).toMatch(/acknowledg/i);
  });

  it("rejects an empty selection and an empty source", async () => {
    ensureProjectExists("default");
    expect(
      (
        await req("POST", "/skills/install", {
          source: "someone/skills",
          names: [],
          acknowledged: true,
        })
      ).statusCode,
    ).toBe(400);
    expect((await req("POST", "/skills/preview", { source: "  " })).statusCode).toBe(
      400,
    );
  });

  it("validates new skill names against Pi's rules", async () => {
    ensureProjectExists("default");
    const bad = await req("POST", "/skills/create", { name: "Not Valid" });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { detail: string }).detail).toMatch(/Invalid skill name/);

    const ok = await req("POST", "/skills/create", {
      name: "lab-workflow",
      description: "Our lab's workflow",
    });
    expect(ok.statusCode).toBe(200);
    const again = await req("POST", "/skills/create", { name: "lab-workflow" });
    expect(again.statusCode).toBe(409);
  });
});

describe("removal over HTTP", () => {
  it("deletes a user-installed skill and 404s afterwards", async () => {
    const paths = ensureProjectExists("default");
    writeSkill(paths.skillsDir, "mine", "installed by hand");
    recordSkillOrigin(paths, "mine", { origin: "registry", source: "owner/repo" });

    const res = await req("DELETE", "/skills/mine");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "mine", disposition: "deleted" });
    expect((await req("DELETE", "/skills/mine")).statusCode).toBe(404);
  });

  it("has nothing to check for a locally authored skill", async () => {
    ensureProjectExists("default");
    await req("POST", "/skills/create", { name: "hand-written" });
    const res = await req("POST", "/skills/hand-written/check-update");
    expect(res.statusCode).toBe(400);
    expect((res.json() as { detail: string }).detail).toMatch(/no source/i);
  });
});
