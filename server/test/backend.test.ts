import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  createProject,
  deleteProject,
  ensureProjectExists,
  getProject,
  listProjects,
  resolvePaths,
  updateProject,
} from "../src/projects.ts";
import {
  isBudgetExceeded,
  projectCostSummary,
  recordRun,
  recordSubagentRun,
  sessionCostSummary,
} from "../src/cost/ledger.ts";
import { guessMime, isUserVisible } from "../src/sandbox-fs.ts";
import { listProjectSkills, seedProjectSkills } from "../src/agent/skills.ts";
import { toClientFrame, relativizeSandboxPaths } from "../src/agent/events.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("projects", () => {
  it("creates, lists, gets, updates, and deletes", () => {
    const p = createProject({ name: "My Study", tags: ["bio"], spendLimitUsd: 5 });
    expect(p.id).toMatch(/^my-study-/);
    expect(p.spendLimitUsd).toBe(5);
    expect(getProject(p.id)?.name).toBe("My Study");

    updateProject(p.id, { description: "updated", spendLimitUsd: null });
    expect(getProject(p.id)?.description).toBe("updated");
    expect(getProject(p.id)?.spendLimitUsd).toBeNull();

    expect(listProjects().some((m) => m.id === p.id)).toBe(true);
    deleteProject(p.id);
    expect(getProject(p.id)).toBeNull();
  });

  it("ensureProjectExists seeds a bare project.json", () => {
    const paths = ensureProjectExists("default");
    expect(fs.existsSync(paths.projectJson)).toBe(true);
    expect(getProject("default")?.name).toBe("Default");
  });

  it("refuses to delete the default project", () => {
    ensureProjectExists("default");
    expect(() => deleteProject("default")).toThrow();
  });

  it("rejects traversal in resolvePaths", () => {
    expect(() => resolvePaths("../escape")).toThrow();
  });
});

describe("cost ledger + budget", () => {
  it("records run deltas and aggregates", () => {
    ensureProjectExists("default");
    const before = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    const after = { costUsd: 0.01, input: 100, output: 20, cacheRead: 0, total: 120 };
    recordRun({ sessionId: "s1", projectId: "default", model: "openai/gpt-4o-mini", before, after });

    const sess = sessionCostSummary("s1", "default");
    expect(sess.totalUsd).toBeCloseTo(0.01);
    expect(sess.totalTokens).toBe(120);
    expect(sess.entries).toHaveLength(1);
    expect(sess.agentUsd).toBeCloseTo(0.01);

    const proj = projectCostSummary("default");
    expect(proj.totalUsd).toBeCloseTo(0.01);
    expect(proj.sessionCount).toBe(1);
  });

  it("skips zero-delta runs", () => {
    ensureProjectExists("default");
    const z = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    expect(recordRun({ sessionId: "s2", projectId: "default", model: "m", before: z, after: z })).toBeNull();
  });

  it("flags budget exceeded once spend passes the cap", () => {
    createProject({ name: "Capped", projectId: "capped", spendLimitUsd: 0.005 });
    recordRun({
      sessionId: "s1",
      projectId: "capped",
      model: "m",
      before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
      after: { costUsd: 0.01, input: 10, output: 5, cacheRead: 0, total: 15 },
    });
    const b = isBudgetExceeded("capped");
    expect(b.exceeded).toBe(true);
    expect(b.limitUsd).toBe(0.005);
  });

  it("treats a 0 spend limit as unlimited (not a hard block)", () => {
    createProject({ name: "Zero", projectId: "zero", spendLimitUsd: 0 });
    recordRun({
      sessionId: "s1",
      projectId: "zero",
      model: "m",
      before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
      after: { costUsd: 1, input: 10, output: 5, cacheRead: 0, total: 15 },
    });
    const b = isBudgetExceeded("zero");
    expect(b.exceeded).toBe(false);
    expect(b.limitUsd).toBeNull();
  });

  it("ledgers subagent spend as a subagent row", () => {
    ensureProjectExists("default");
    recordSubagentRun("default", "s9", "openai/gpt-4o-mini", {
      cost: 0.02,
      tokens: { input: 50, output: 10, cacheRead: 0, total: 60 },
    });
    const sess = sessionCostSummary("s9", "default");
    expect(sess.subagentUsd).toBeCloseTo(0.02);
    expect(sess.agentUsd).toBe(0);
    expect(sess.entries[0].role).toBe("subagent");
  });
});

describe("sandbox-fs", () => {
  const root = "/tmp/sbx";
  it("hides dotfiles, sidecars, and known system names", () => {
    expect(isUserVisible(path.join(root, "data.csv"), root)).toBe(true);
    expect(isUserVisible(path.join(root, ".kady", "x"), root)).toBe(false);
    expect(isUserVisible(path.join(root, "doc.pdf.annotations.json"), root)).toBe(false);
    expect(isUserVisible(path.join(root, "GEMINI.md"), root)).toBe(false);
  });
  it("guesses mime types", () => {
    expect(guessMime("a.pdf")).toBe("application/pdf");
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("skills", () => {
  it("copies skills from a sibling project and lists them", () => {
    // sibling with one skill
    const sib = resolvePaths("sib");
    const skillDir = path.join(sib.skillsDir, "anndata");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: anndata\ndescription: Annotated matrices.\n---\n# anndata\n",
    );
    const target = ensureProjectExists("default");
    const count = seedProjectSkills(target, false); // no network
    expect(count).toBe(1);
    const listed = listProjectSkills(target);
    expect(listed.map((s) => s.name)).toContain("anndata");
  });
});

describe("events → client frames", () => {
  it("maps text/thinking deltas and tool/lifecycle events", () => {
    expect(toClientFrame({ type: "agent_start" } as never)).toEqual({ type: "agent_start" });
    expect(
      toClientFrame({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "hi" } as never,
      } as never),
    ).toEqual({ type: "text_delta", delta: "hi" });
    expect(
      toClientFrame({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
      } as never),
    ).toMatchObject({ type: "tool_start", toolName: "bash" });
    // Unmapped internal event → null
    expect(toClientFrame({ type: "session_info_changed", name: "x" } as never)).toBeNull();
  });

  it("relativizes absolute sandbox paths in tool args", () => {
    const root = "/Users/x/projects/p/sandbox";
    // Exact path field → bare relative path.
    expect(relativizeSandboxPaths({ path: `${root}/de_analysis.py` }, root)).toEqual({
      path: "de_analysis.py",
    });
    // Nested folder under sandbox stays relative.
    expect(relativizeSandboxPaths(`${root}/user_data/x.csv`, root)).toBe("user_data/x.csv");
    // Embedded in a bash command → collapsed to ".".
    expect(
      relativizeSandboxPaths(`cd ${root} && uv run python de_analysis.py`, root),
    ).toBe("cd . && uv run python de_analysis.py");
    // Paths outside the sandbox are untouched; empty root is a no-op.
    expect(relativizeSandboxPaths("/etc/hosts", root)).toBe("/etc/hosts");
    expect(relativizeSandboxPaths(`${root}/a.py`, "")).toBe(`${root}/a.py`);
  });

  it("strips sandbox paths in the streamed tool_start frame", () => {
    const root = "/Users/x/projects/p/sandbox";
    const frame = toClientFrame(
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "write",
        args: { path: `${root}/notes.md` },
      } as never,
      root,
    );
    expect(frame).toMatchObject({ type: "tool_start", args: { path: "notes.md" } });
  });
});
