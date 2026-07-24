/**
 * Seeding runs on every request through ensureProjectExists, so "write if
 * missing" alone meant a deleted AGENTS.md or pyproject.toml came back seconds
 * later and the user could never get rid of it.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { seedSandboxFiles } from "../src/sandbox-seed.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function agentsMd(projectId: string): string {
  return path.join(resolvePaths(projectId).sandbox, "AGENTS.md");
}

describe("seedSandboxFiles", () => {
  it("writes the seed files on first provisioning", () => {
    const paths = ensureProjectExists("seed-a");
    seedSandboxFiles(paths);
    expect(fs.existsSync(agentsMd("seed-a"))).toBe(true);
    expect(fs.existsSync(path.join(paths.sandbox, "pyproject.toml"))).toBe(true);
  });

  it("leaves a deleted seed file deleted across later requests", () => {
    const paths = ensureProjectExists("seed-b");
    seedSandboxFiles(paths);
    fs.rmSync(agentsMd("seed-b"));
    seedSandboxFiles(paths);
    seedSandboxFiles(paths);
    expect(fs.existsSync(agentsMd("seed-b"))).toBe(false);
  });

  it("restores a deleted seed file only when forced", () => {
    const paths = ensureProjectExists("seed-c");
    seedSandboxFiles(paths);
    fs.rmSync(agentsMd("seed-c"));
    seedSandboxFiles(paths, { force: true });
    expect(fs.existsSync(agentsMd("seed-c"))).toBe(true);
  });

  it("never overwrites an edited seed file", () => {
    const paths = ensureProjectExists("seed-d");
    seedSandboxFiles(paths);
    fs.writeFileSync(agentsMd("seed-d"), "# my own instructions\n", "utf-8");
    seedSandboxFiles(paths, { force: true });
    expect(fs.readFileSync(agentsMd("seed-d"), "utf-8")).toBe("# my own instructions\n");
  });
});
