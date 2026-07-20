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
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  projectCostSummary,
  recordRun,
  recordSubagentRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
} from "../src/cost/ledger.ts";
import { usageFromSessionFile } from "../src/agent/subagent-bridge.ts";
import {
  WEB_ACCESS_TOOLS,
  seedWebAccessPackage,
  trustSandbox,
  webAccessPackageDir,
} from "../src/agent/web-access-bridge.ts";
import { guessMime, isUserVisible } from "../src/sandbox-fs.ts";
import {
  listDisabledSkills,
  listProjectSkills,
  seedProjectSkills,
} from "../src/agent/skills.ts";
import {
  contextUsageForClient,
  contextUsageFrame,
  MAX_TOOL_RESULT_IMAGES,
  toClientFrame,
  relativizeSandboxPaths,
} from "../src/agent/events.ts";
import { helperPython, HELPERS_DIR } from "../src/helpers-env.ts";
import { sciHelperFor } from "../src/api/sci-helpers.ts";

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

  it("excludes run dirs with no ledger entries from sessionCount", () => {
    const paths = ensureProjectExists("default");
    recordRun({
      sessionId: "s1",
      projectId: "default",
      model: "m",
      before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
      after: { costUsd: 0.01, input: 100, output: 20, cacheRead: 0, total: 120 },
    });
    fs.mkdirSync(path.join(paths.runsDir, "empty-session"), { recursive: true });
    const proj = projectCostSummary("default");
    expect(proj.sessionCount).toBe(1);
  });

  it("snapshot helpers: delta clamps at 0, max combines measurements, turn usage accumulates", () => {
    const before = { costUsd: 0.5, input: 100, output: 50, cacheRead: 10, total: 160 };
    // Compaction shrank the stats mid-run: after < before → delta clamps to 0.
    const shrunk = { costUsd: 0.2, input: 40, output: 20, cacheRead: 0, total: 60 };
    const delta = snapshotDelta(before, shrunk);
    expect(delta).toEqual(emptySnapshot());

    // The turn tally still saw the spend; max recovers it.
    const tally = emptySnapshot();
    addTurnUsage(tally, {
      input: 30,
      output: 12,
      cacheRead: 5,
      cacheWrite: 3,
      cost: { total: 0.04 },
    });
    expect(tally.total).toBe(50);
    const run = snapshotMax(delta, tally);
    expect(run.costUsd).toBeCloseTo(0.04);
    expect(run.total).toBe(50);
  });

  it("sums assistant usage from a child Pi session file", () => {
    const dir = path.join(PROJECTS_ROOT, "tmp-subagent");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "child-session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "child" }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, cost: { total: 0.03 } },
        },
      }),
      JSON.stringify({ message: { role: "user", content: "hi" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
        },
      }),
      "{not json",
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");

    const usage = usageFromSessionFile(file);
    expect(usage).not.toBeNull();
    expect(usage!.cost).toBeCloseTo(0.08);
    expect(usage!.tokens).toEqual({ input: 300, output: 100, cacheRead: 20, total: 425 });

    expect(usageFromSessionFile(path.join(dir, "missing.jsonl"))).toBeNull();
  });
});

describe("sandbox-fs", () => {
  const root = "/tmp/sbx";
  it("hides dotfiles, sidecars, and known system names", () => {
    expect(isUserVisible(path.join(root, "data.csv"), root)).toBe(true);
    expect(isUserVisible(path.join(root, ".kady", "x"), root)).toBe(false);
    expect(isUserVisible(path.join(root, "doc.pdf.annotations.json"), root)).toBe(false);
    expect(isUserVisible(path.join(root, "AGENTS.md"), root)).toBe(false);
    expect(isUserVisible(path.join(root, "GEMINI.md"), root)).toBe(false);
  });
  it("guesses mime types", () => {
    expect(guessMime("a.pdf")).toBe("application/pdf");
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.unknownext")).toBe("application/octet-stream");
    expect(guessMime("m.pdb")).toBe("chemical/x-pdb");
    expect(guessMime("m.cif")).toBe("chemical/x-cif");
    expect(guessMime("m.xyz")).toBe("chemical/x-xyz");
    expect(guessMime("m.mol")).toBe("chemical/x-mdl-molfile");
    expect(guessMime("m.sdf")).toBe("chemical/x-mdl-sdfile");
    expect(guessMime("m.smi")).toBe("text/plain");
    expect(guessMime("a.mzml")).toBe("application/xml");
    expect(guessMime("a.jdx")).toBe("chemical/x-jcamp-dx");
    expect(guessMime("a.parquet")).toBe("application/vnd.apache.parquet");
    expect(guessMime("a.nwk")).toBe("text/plain");
    expect(guessMime("a.dcm")).toBe("application/dicom");
    expect(guessMime("a.nii")).toBe("application/octet-stream");
    expect(guessMime("a.tif")).toBe("image/tiff");
    expect(guessMime("a.tiff")).toBe("image/tiff");
  });
});

describe("skills", () => {
  it("copies sibling skills into their default enabled states", () => {
    const sib = resolvePaths("sib");
    for (const [name, description] of [
      ["anndata", "Annotated matrices."],
      ["literature-review", "Systematic literature reviews."],
    ]) {
      const skillDir = path.join(sib.skillsDir, name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
      );
    }

    const target = ensureProjectExists("default");
    const count = seedProjectSkills(target, false); // no network
    expect(count).toBe(2);
    expect(listProjectSkills(target).map((s) => s.name)).toContain("literature-review");
    expect(listDisabledSkills(target).map((s) => s.name)).toContain("anndata");
  });
});

describe("events → client frames", () => {
  it("keeps context usage unknown until the provider has measured the prompt", () => {
    const rawUsage = { tokens: 0, contextWindow: 200_000, percent: 0 };
    expect(
      contextUsageForClient({
        getContextUsage: () => rawUsage,
        messages: [],
      } as never),
    ).toEqual({ tokens: null, contextWindow: 200_000, percent: null });

    expect(
      contextUsageForClient({
        getContextUsage: () => ({ tokens: 120, contextWindow: 200_000, percent: 0.06 }),
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: {
              input: 100,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 120,
            },
          },
        ],
      } as never),
    ).toEqual({ tokens: 120, contextWindow: 200_000, percent: 0.06 });
  });

  it("maps Pi context utilization onto the client wire shape", () => {
    expect(
      contextUsageFrame({
        tokens: 42_000,
        contextWindow: 200_000,
        percent: 21,
      }),
    ).toEqual({
      type: "context_usage",
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
    });
    expect(contextUsageFrame(undefined)).toBeNull();
  });

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

  it("streams only validated scientific details and bounded raster images", () => {
    const root = "/Users/x/projects/p/sandbox";
    const images = Array.from({ length: MAX_TOOL_RESULT_IMAGES + 1 }, (_, index) => ({
      type: "image",
      data: Buffer.from(`image-${index}`).toString("base64"),
      mimeType: "image/png",
    }));
    images.push({
      type: "image",
      data: Buffer.from("svg").toString("base64"),
      mimeType: "image/svg+xml",
    });
    const frame = toClientFrame(
      {
        type: "tool_execution_end",
        toolCallId: "scientific-1",
        toolName: "scientific_result",
        isError: false,
        result: {
          content: [{ type: "text", text: `saved ${root}/plot.png` }, ...images],
          details: {
            scientificResult: {
              schemaVersion: 1,
              kind: "plot",
              title: "Volcano plot",
              images: [{ path: `${root}/plot.png`, alt: "Volcano plot" }],
            },
            secret: "not on the wire",
          },
        },
      } as never,
      root,
    );
    expect(frame).toMatchObject({
      type: "tool_end",
      result: "saved plot.png",
      scientificResult: {
        kind: "plot",
        images: [{ path: "plot.png" }],
      },
      imagesTruncated: 2,
    });
    expect((frame?.images as unknown[])).toHaveLength(MAX_TOOL_RESULT_IMAGES);
    expect(frame).not.toHaveProperty("details");
    expect(frame).not.toHaveProperty("secret");
  });

  it("does not forward arbitrary tool-result details", () => {
    expect(
      toClientFrame({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        isError: false,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { env: { API_KEY: "secret" } },
        },
      } as never),
    ).toEqual({
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      result: "ok",
    });
  });

  it("includes content on user message_start (string and content-array forms)", () => {
    expect(
      toClientFrame({
        type: "message_start",
        message: { role: "user", content: "exclude sample 7" },
      } as never),
    ).toEqual({ type: "message_start", role: "user", content: "exclude sample 7" });

    expect(
      toClientFrame({
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "look at" },
            { type: "image", data: "…", mimeType: "image/png" },
            { type: "text", text: "plot.png" },
          ],
        },
      } as never),
    ).toEqual({ type: "message_start", role: "user", content: "look at\nplot.png" });
  });

  it("omits content on assistant message_start", () => {
    expect(
      toClientFrame({
        type: "message_start",
        message: { role: "assistant", content: "internal" },
      } as never),
    ).toEqual({ type: "message_start", role: "assistant" });
  });
});

describe("web access bridge", () => {
  const settingsPath = (sandbox: string) => path.join(sandbox, ".pi", "settings.json");
  const readSettings = (sandbox: string) =>
    JSON.parse(fs.readFileSync(settingsPath(sandbox), "utf-8")) as {
      packages?: string[];
      [k: string]: unknown;
    };

  it("exposes the pi-web-access tool names", () => {
    expect(WEB_ACCESS_TOOLS).toEqual([
      "web_search",
      "code_search",
      "fetch_content",
      "get_search_content",
    ]);
    expect(fs.existsSync(path.join(webAccessPackageDir(), "index.ts"))).toBe(true);
  });

  it("seeds the package reference into project settings, idempotently", () => {
    const paths = ensureProjectExists("default");
    expect(seedWebAccessPackage(paths)).toBe(true);
    expect(readSettings(paths.sandbox).packages).toEqual([webAccessPackageDir()]);
    // Second call is a no-op.
    expect(seedWebAccessPackage(paths)).toBe(false);
    expect(readSettings(paths.sandbox).packages).toEqual([webAccessPackageDir()]);
  });

  it("preserves existing settings and repairs stale references", () => {
    const paths = ensureProjectExists("default");
    fs.mkdirSync(path.dirname(settingsPath(paths.sandbox)), { recursive: true });
    fs.writeFileSync(
      settingsPath(paths.sandbox),
      JSON.stringify({
        theme: "dark",
        packages: ["npm:some-other-package", "/old/location/node_modules/pi-web-access"],
      }),
      "utf-8",
    );
    expect(seedWebAccessPackage(paths)).toBe(true);
    const settings = readSettings(paths.sandbox);
    expect(settings.theme).toBe("dark");
    expect(settings.packages).toEqual(["npm:some-other-package", webAccessPackageDir()]);
  });

  it("leaves an unparseable settings file untouched", () => {
    const paths = ensureProjectExists("default");
    fs.mkdirSync(path.dirname(settingsPath(paths.sandbox)), { recursive: true });
    fs.writeFileSync(settingsPath(paths.sandbox), "{not json", "utf-8");
    expect(seedWebAccessPackage(paths)).toBe(false);
    expect(fs.readFileSync(settingsPath(paths.sandbox), "utf-8")).toBe("{not json");
  });

  it("pre-trusts the sandbox without overriding an explicit distrust", () => {
    const paths = ensureProjectExists("default");
    const agentDir = path.join(PROJECTS_ROOT, "fake-agent-dir");
    trustSandbox(paths, agentDir);
    const trustFile = path.join(agentDir, "trust.json");
    const trusted = JSON.parse(fs.readFileSync(trustFile, "utf-8")) as Record<string, boolean>;
    expect(Object.values(trusted)).toEqual([true]);

    // A user's explicit "no" sticks.
    const key = Object.keys(trusted)[0];
    fs.writeFileSync(trustFile, JSON.stringify({ [key]: false }), "utf-8");
    trustSandbox(paths, agentDir);
    expect(
      (JSON.parse(fs.readFileSync(trustFile, "utf-8")) as Record<string, boolean>)[key],
    ).toBe(false);
  });
});

describe("helper python resolution", () => {
  it("honors KADY_PYTHON when set", () => {
    const prev = process.env.KADY_PYTHON;
    process.env.KADY_PYTHON = "/custom/python";
    expect(helperPython()).toBe("/custom/python");
    if (prev === undefined) delete process.env.KADY_PYTHON;
    else process.env.KADY_PYTHON = prev;
  });

  it("points HELPERS_DIR at the helpers source dir", () => {
    expect(HELPERS_DIR.endsWith(path.join("src", "helpers"))).toBe(true);
  });
});

describe("sci helper dispatch", () => {
  it("returns null for an unknown kind", () => {
    expect(sciHelperFor("bogus")).toBeNull();
  });
  it("resolves known kinds to a helper script path", () => {
    expect(sciHelperFor("chem")?.script.endsWith("chem_helper.py")).toBe(true);
    expect(sciHelperFor("structure")?.script.endsWith("structure_helper.py")).toBe(true);
  });
  it("resolves the massspec kind", () => {
    expect(sciHelperFor("massspec")?.script.endsWith("massspec_helper.py")).toBe(true);
  });
  it("resolves the arrays kind", () => {
    expect(sciHelperFor("arrays")?.script.endsWith("arrays_helper.py")).toBe(true);
  });
  it("resolves the imaging kind", () => {
    expect(sciHelperFor("imaging")?.script.endsWith("imaging_helper.py")).toBe(true);
  });
});
