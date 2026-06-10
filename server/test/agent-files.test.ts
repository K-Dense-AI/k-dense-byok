import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  deleteProjectAgent,
  listAgents,
  listBuiltinAgents,
  listProjectAgents,
  parseAgentMarkdown,
  restoreDefaultAgents,
  seedAgentFiles,
  serializeAgentMarkdown,
  writeProjectAgent,
} from "../src/agent/agent-files.ts";
import { SUBAGENT_TYPES } from "../src/agent/subagents.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("agent markdown", () => {
  it("round-trips all modeled fields", () => {
    const original = {
      name: "my-agent",
      description: 'Checks stats: power, p-values, "edge cases"',
      model: "anthropic/claude-opus-4.8",
      thinking: "high",
      tools: "read, grep, bash",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: true,
      systemPrompt: "You are a reviewer.\n\nBe thorough.",
    };
    const parsed = parseAgentMarkdown(serializeAgentMarkdown(original), "fallback", "project");
    expect(parsed).toMatchObject(original);
  });

  it("preserves unknown frontmatter keys via extra", () => {
    const text = [
      "---",
      "name: custom",
      "description: x",
      "defaultReads: plan.md, progress.md",
      "maxTokens: 50000",
      "---",
      "Prompt body",
    ].join("\n");
    const parsed = parseAgentMarkdown(text, "custom", "project");
    expect(parsed.extra).toEqual({ defaultReads: "plan.md, progress.md", maxTokens: "50000" });
    const reserialized = serializeAgentMarkdown(parsed);
    expect(reserialized).toContain("defaultReads: plan.md, progress.md");
    expect(reserialized).toContain("maxTokens: 50000");
  });

  it("falls back to the filename when frontmatter is missing", () => {
    const parsed = parseAgentMarkdown("Just a prompt", "no-frontmatter", "project");
    expect(parsed.name).toBe("no-frontmatter");
    expect(parsed.systemPrompt).toBe("Just a prompt");
  });
});

describe("agent files CRUD + seeding", () => {
  it("seeds the scientific roster once, then respects deletions", () => {
    const paths = ensureProjectExists("seed-test");
    expect(seedAgentFiles(paths)).toBe(SUBAGENT_TYPES.length);
    expect(listProjectAgents(paths)).toHaveLength(SUBAGENT_TYPES.length);

    expect(deleteProjectAgent(paths, "code-reviewer")).toBe(true);
    // Re-seeding is a no-op after the marker exists — the deletion sticks.
    expect(seedAgentFiles(paths)).toBe(0);
    expect(listProjectAgents(paths).some((a) => a.name === "code-reviewer")).toBe(false);
  });

  it("writes, lists, and validates project agents", () => {
    const paths = ensureProjectExists("crud-test");
    const agent = writeProjectAgent(paths, "my-checker", {
      description: "desc",
      systemPrompt: "Do checks.",
      thinking: "low",
    });
    expect(agent.source).toBe("project");
    expect(listProjectAgents(paths).map((a) => a.name)).toContain("my-checker");
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "my-checker.md"))).toBe(true);

    expect(() => writeProjectAgent(paths, "Bad Name", { description: "", systemPrompt: "x" }))
      .toThrow(/Invalid agent name/);
    expect(() => writeProjectAgent(paths, "ok", { description: "", systemPrompt: "  " }))
      .toThrow(/System prompt/);
    expect(() =>
      writeProjectAgent(paths, "ok", { description: "", systemPrompt: "x", thinking: "ultra" }),
    ).toThrow(/thinking/);
  });

  it("restore-defaults rewrites the roster but keeps custom agents", () => {
    const paths = ensureProjectExists("restore-test");
    seedAgentFiles(paths);
    writeProjectAgent(paths, "code-reviewer", { description: "mine", systemPrompt: "Custom." });
    writeProjectAgent(paths, "my-own", { description: "keep", systemPrompt: "Keep me." });

    restoreDefaultAgents(paths);
    const agents = listProjectAgents(paths);
    const reviewer = agents.find((a) => a.name === "code-reviewer");
    expect(reviewer?.description).not.toBe("mine");
    expect(agents.some((a) => a.name === "my-own")).toBe(true);
  });

  it("lists builtins from the pi-subagents package, shadowed by project agents", () => {
    const paths = ensureProjectExists("builtin-test");
    const builtins = listBuiltinAgents();
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((a) => a.source === "builtin")).toBe(true);

    const shadowName = builtins[0].name;
    writeProjectAgent(paths, shadowName, { description: "override", systemPrompt: "Mine." });
    const all = listAgents(paths);
    const entry = all.filter((a) => a.name === shadowName);
    expect(entry).toHaveLength(1);
    expect(entry[0].source).toBe("project");
  });
});
