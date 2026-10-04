/**
 * Verifier model routing (Settings → Defaults → Verifier model): the
 * projection into `subagents.agentOverrides.<verifier>.model`, Kady's
 * ownership of what it wrote, and the seeding that brings the new roster
 * specialists and the `/prove-verify` template to existing projects.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, type ProjectPaths } from "../src/projects.ts";
import { piSettingsPath } from "../src/agent/capability-state.ts";
import { deleteProjectAgent, listProjectAgents, seedAgentFiles, writeProjectAgent } from "../src/agent/agent-files.ts";
import { SEEDED_TEMPLATES, seedPromptTemplates, listPromptTemplates } from "../src/agent/prompts.ts";
import { SUBAGENT_TYPES } from "../src/agent/subagents.ts";
import {
  isVerifierAgent,
  reconcileVerifierModels,
  routedVerifiers,
  verifierAgentNames,
} from "../src/agent/verifier-models.ts";
import { CHILD_OPERATING_GUIDANCE, LEAD_DELEGATION_GUIDANCE, verifierModelGuidance } from "../src/agent/subagent-prompts.ts";
import { makeSubagentLedgerExtension } from "../src/agent/subagent-bridge.ts";
import { appSettingsPath, writeAppDefaults } from "../src/app-settings.ts";

const MODEL = "openrouter/anthropic/claude-opus-5.5";
const OTHER = "openrouter/google/gemini-3.1-pro";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

/** A project that has had a session built: its roster and a settings file exist. */
function seeded(id = "verifier-test", { settingsFile = true } = {}): ProjectPaths {
  const paths = ensureProjectExists(id);
  seedAgentFiles(paths);
  if (settingsFile) {
    fs.mkdirSync(path.dirname(piSettingsPath(paths)), { recursive: true });
    fs.writeFileSync(piSettingsPath(paths), "{}\n");
  }
  return paths;
}
const settings = (paths: ProjectPaths) => JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
const overrides = (paths: ProjectPaths) => settings(paths).subagents?.agentOverrides ?? {};
const writeSettings = (paths: ProjectPaths, value: unknown) => {
  fs.mkdirSync(path.dirname(piSettingsPath(paths)), { recursive: true });
  fs.writeFileSync(piSettingsPath(paths), JSON.stringify(value, null, 2));
};

describe("verifier roster", () => {
  it("covers the reviewer personas, the comparative reviewer and the builtin reviewers, not producers", () => {
    const names = verifierAgentNames();
    for (const name of ["statistical-reviewer", "math-checker", "citation-checker", "comparative-reviewer", "reviewer", "evidence-auditor"]) {
      expect(names, name).toContain(name);
    }
    for (const name of ["investigator", "pipeline-engineer", "literature-researcher", "hypothesis-generator", "worker"]) {
      expect(isVerifierAgent(name), name).toBe(false);
    }
  });
});

describe("reconcileVerifierModels", () => {
  it("routes every verifier present in the project and records ownership", () => {
    const paths = seeded();
    const result = reconcileVerifierModels(paths, MODEL);
    expect(result.changed).toBe(true);
    const entries = overrides(paths);
    for (const name of verifierAgentNames()) expect(entries[name]?.model, name).toBe(MODEL);
    expect(entries.investigator).toBeUndefined();
    expect(entries["pipeline-engineer"]).toBeUndefined();
    expect(routedVerifiers(paths)).toEqual({ model: MODEL, agents: [...verifierAgentNames()].sort() });
    // Idempotent.
    expect(reconcileVerifierModels(paths, MODEL).changed).toBe(false);
  });

  it("follows a changed default and removes only its own entries when cleared", () => {
    const paths = seeded();
    writeSettings(paths, {
      packages: ["npm:pi-web-access"],
      subagents: { defaultModel: OTHER, agentOverrides: { reviewer: { tools: ["read", "notebook"] } } },
    });
    reconcileVerifierModels(paths, MODEL);
    expect(overrides(paths).reviewer).toEqual({ tools: ["read", "notebook"], model: MODEL });
    reconcileVerifierModels(paths, OTHER);
    expect(overrides(paths)["math-checker"].model).toBe(OTHER);
    reconcileVerifierModels(paths, undefined);
    const after = settings(paths);
    // Other keys, the project specialist default and the tools entry survive.
    expect(after.packages).toEqual(["npm:pi-web-access"]);
    expect(after.subagents.defaultModel).toBe(OTHER);
    expect(after.subagents.agentOverrides).toEqual({ reviewer: { tools: ["read", "notebook"] } });
    expect(routedVerifiers(paths)).toBeNull();
  });

  it("never touches a user's own override, and releases an entry the user edited", () => {
    const paths = seeded();
    writeSettings(paths, { subagents: { agentOverrides: { "math-checker": { model: OTHER }, "fact-checker": { model: false } } } });
    reconcileVerifierModels(paths, MODEL);
    expect(overrides(paths)["math-checker"].model).toBe(OTHER);
    expect(overrides(paths)["fact-checker"].model).toBe(false);
    expect(overrides(paths)["code-reviewer"].model).toBe(MODEL);

    // The user re-points one Kady wrote: it is theirs from now on.
    const edited = settings(paths);
    edited.subagents.agentOverrides["code-reviewer"].model = OTHER;
    writeSettings(paths, edited);
    reconcileVerifierModels(paths, undefined);
    expect(overrides(paths)["code-reviewer"].model).toBe(OTHER);
    expect(overrides(paths)["statistical-reviewer"]).toBeUndefined();
    reconcileVerifierModels(paths, MODEL);
    expect(overrides(paths)["code-reviewer"].model).toBe(OTHER);
  });

  it("leaves a verifier that pins its own model alone, and steps back when one is pinned later", () => {
    const paths = seeded();
    reconcileVerifierModels(paths, MODEL);
    const agent = listProjectAgents(paths).find((a) => a.name === "statistical-reviewer")!;
    writeProjectAgent(paths, agent.name, { ...agent, model: OTHER });
    reconcileVerifierModels(paths, MODEL);
    // An override would outrank the frontmatter model, so Kady removes its own.
    expect(overrides(paths)["statistical-reviewer"]).toBeUndefined();
    expect(overrides(paths)["math-checker"].model).toBe(MODEL);
  });

  it("leaves a never-opened project without settings alone unless asked", () => {
    const paths = seeded("never-opened", { settingsFile: false });
    expect(reconcileVerifierModels(paths, MODEL)).toEqual({ changed: false, routed: [] });
    expect(fs.existsSync(piSettingsPath(paths))).toBe(false);
    reconcileVerifierModels(paths, MODEL, () => true, { createSettings: true });
    expect(overrides(paths)["math-checker"].model).toBe(MODEL);
    reconcileVerifierModels(paths, undefined);
    // Clearing leaves no empty subagents block behind.
    expect(settings(paths)).toEqual({});
  });

  it("does not route to a model that cannot run now", () => {
    const paths = seeded();
    reconcileVerifierModels(paths, MODEL);
    const result = reconcileVerifierModels(paths, MODEL, () => false);
    expect(result).toMatchObject({ changed: true, routed: [], skipped: "unavailable" });
    expect(overrides(paths)["math-checker"]).toBeUndefined();
  });

  it("skips agents the project no longer has", () => {
    const paths = seeded();
    deleteProjectAgent(paths, "ethics-reviewer");
    reconcileVerifierModels(paths, MODEL);
    expect(overrides(paths)["ethics-reviewer"]).toBeUndefined();
  });

  it("never rewrites a malformed settings file", () => {
    const paths = seeded();
    fs.mkdirSync(path.dirname(piSettingsPath(paths)), { recursive: true });
    fs.writeFileSync(piSettingsPath(paths), "{broken");
    expect(reconcileVerifierModels(paths, MODEL)).toMatchObject({ changed: false, skipped: "malformed-settings" });
    expect(fs.readFileSync(piSettingsPath(paths), "utf-8")).toBe("{broken");
  });
});

describe("delegation", () => {
  afterEach(() => fs.rmSync(appSettingsPath(), { force: true }));

  it("routes a verifier child before launch and pins only the producers to the parent", async () => {
    const paths = seeded("verifier-launch");
    writeAppDefaults({ verifierModel: MODEL });
    const handlers: Record<string, (event: unknown, ctx?: unknown) => Promise<unknown>> = {};
    makeSubagentLedgerExtension(
      "verifier-launch",
      () => "parent",
      () => ({ provider: "openai-codex", id: "gpt-5.6-sol" }) as never,
      () => true,
      () => true,
    )({ on: (name: string, fn: never) => (handlers[name] = fn), events: { on: () => undefined } } as never);
    const input = { tasks: [{ agent: "math-checker", task: "Verification gate: check" }, { agent: "investigator", task: "work" }] };
    expect(await handlers.tool_call({ toolName: "subagent", toolCallId: "c1", input }, { cwd: paths.sandbox })).toBeUndefined();
    expect(overrides(paths)["math-checker"].model).toBe(MODEL);
    // The verifier is resolved from its override; a parent pin would outrank it.
    expect(input.tasks[0]).not.toHaveProperty("model");
    expect(input.tasks[1]).toMatchObject({ model: "openai-codex/gpt-5.6-sol" });
  });
});

describe("seeding later roster and template additions", () => {
  it("adds new specialists to a project seeded before them, once", () => {
    const paths = ensureProjectExists("legacy-roster");
    const dir = path.join(paths.sandbox, ".pi", "agents");
    fs.mkdirSync(dir, { recursive: true });
    // A project seeded by an older Kady: legacy marker, no names file.
    fs.writeFileSync(path.join(dir, ".seeded"), "2026-01-01T00:00:00.000Z\n");
    fs.writeFileSync(path.join(dir, "code-reviewer.md"), "---\nname: code-reviewer\ndescription: mine\n---\n\nMine.\n");
    expect(seedAgentFiles(paths)).toBe(2);
    const names = listProjectAgents(paths).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["comparative-reviewer", "investigator", "code-reviewer"]));
    // Deleted legacy specialists stay deleted, edited ones are untouched.
    expect(names).not.toContain("math-checker");
    expect(fs.readFileSync(path.join(dir, "code-reviewer.md"), "utf-8")).toContain("Mine.");
    // And a deleted new one stays deleted too.
    deleteProjectAgent(paths, "investigator");
    expect(seedAgentFiles(paths)).toBe(0);
    expect(listProjectAgents(paths).map((a) => a.name)).not.toContain("investigator");
  });

  it("seeds a fresh project with the whole roster", () => {
    const paths = ensureProjectExists("fresh-roster");
    expect(seedAgentFiles(paths)).toBe(SUBAGENT_TYPES.length);
    expect(seedAgentFiles(paths)).toBe(0);
  });

  it("adds /prove-verify to a project whose templates were seeded before it, once", () => {
    const paths = ensureProjectExists("legacy-templates");
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    fs.writeFileSync(path.join(paths.kadyDir, "prompts-seeded"), "2026-01-01T00:00:00.000Z\n");
    expect(seedPromptTemplates(paths)).toBe(1);
    const names = listPromptTemplates(paths, "project").map((t) => t.name);
    expect(names).toContain("prove-verify");
    expect(names).not.toContain("qc"); // deleted before, stays deleted
    fs.rmSync(path.join(paths.sandbox, ".pi", "prompts", "prove-verify.md"));
    expect(seedPromptTemplates(paths)).toBe(0);
  });

  it("ships the prove-verify template with its loop contract", () => {
    const template = SEEDED_TEMPLATES.find((t) => t.name === "prove-verify")!.content;
    for (const fragment of ["$ARGUMENTS", "Verification gate:", "comparative-reviewer", "investigator", "ledger.md", "report.md", "Excluded"]) {
      expect(template, fragment).toContain(fragment);
    }
  });
});

describe("guidance", () => {
  it("defines the verification gate for children and tells the lead how to request it", () => {
    expect(CHILD_OPERATING_GUIDANCE).toMatch(/Verification gate/);
    expect(CHILD_OPERATING_GUIDANCE).toMatch(/Verdict: accept/);
    expect(LEAD_DELEGATION_GUIDANCE).toMatch(/"Verification gate:"/);
    expect(verifierModelGuidance(MODEL, ["math-checker"])).toContain(`math-checker) run on ${MODEL}`);
  });
});
