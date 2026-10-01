import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { SEEDED_TEMPLATES, seedPromptTemplates } from "../src/agent/prompts.ts";
import { WATCHDOG_MD, seedWatchdogGuidance } from "../src/agent/watchdog-settings.ts";

beforeEach(() => fs.rmSync(PROJECTS_ROOT, { force: true, recursive: true }));
afterAll(() => fs.rmSync(PROJECTS_ROOT, { force: true, recursive: true }));

it("upgrades historic shipped text with CRLF, preserves edits and does not resurrect deletions", () => {
  const paths = resolvePaths(createProject({ name: "Upgrade" }).id);
  seedPromptTemplates(paths);
  seedWatchdogGuidance(paths);
  const cases = [
    { file: path.join(paths.sandbox, ".pi/prompts/qc.md"), fixture: "qc-v1.md", current: SEEDED_TEMPLATES.find((p) => p.name === "qc")!.content, seed: () => seedPromptTemplates(paths) },
    { file: path.join(paths.sandbox, ".pi/WATCHDOG.md"), fixture: "watchdog-v1.md", current: WATCHDOG_MD, seed: () => seedWatchdogGuidance(paths) },
  ];
  for (const c of cases) {
    const old = fs.readFileSync(new URL(`./fixtures/prompt-defaults/${c.fixture}`, import.meta.url), "utf8");
    fs.writeFileSync(c.file, old.replace(/\n/g, "\r\n"));
    c.seed();
    expect(fs.readFileSync(c.file, "utf8")).toBe(c.current);
    const edited = old + "\nLocal requirements\n";
    fs.writeFileSync(c.file, edited);
    c.seed();
    expect(fs.readFileSync(c.file, "utf8")).toBe(edited);
    fs.rmSync(c.file);
    c.seed();
    expect(fs.existsSync(c.file)).toBe(false);
  }
});
