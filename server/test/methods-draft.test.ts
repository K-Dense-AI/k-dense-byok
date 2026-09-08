import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { emptySnapshot, recordRun, sessionCostSummary } from "../src/cost/ledger.ts";
import { appendNotebookEntry, type NotebookEntry } from "../src/agent/notebook-store.ts";
import { previewAnalysisPlan, freezeAnalysisPlan, recordPlanDeviation } from "../src/agent/notebook-plans.ts";
import {
  METHODS_DRAFT_SESSION_ID,
  buildMethodsDraftContext,
  runMethodsDraft,
} from "../src/agent/methods-draft.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

const entryOf = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "e1", type: "method", title: "Ran PCA", timestamp: 1000, role: "agent", ...over,
});

function fakeMessage(text: string, over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: {
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...over,
  } as AssistantMessage;
}

describe("buildMethodsDraftContext", () => {
  const entries: NotebookEntry[] = [
    { id: "h1", type: "hypothesis", title: "Six populations exist", timestamp: 1000, role: "agent" },
    { id: "m1", type: "method", title: "Ran PCA", timestamp: 2000, role: "agent",
      code: { source: "sc.pp.pca(adata)", lang: "python" }, artifacts: ["figures/pca.png"] },
    { id: "o1", type: "observation", title: "Variance explained", timestamp: 3000, role: "agent",
      relatesTo: "h1", stance: "supports" },
    { id: "d1", type: "decision", title: "Keep 10 PCs", timestamp: 4000, role: "agent" },
    { id: "n1", type: "note", title: "Housekeeping only", timestamp: 5000, role: "agent" },
  ];
  const ctx = buildMethodsDraftContext(entries, { sessionId: "s", projectName: "P" });
  const text = ctx.messages[0].content as string;

  it("digests method / decision / observation titles", () => {
    expect(text).toContain("METHOD: Ran PCA");
    expect(text).toContain("DECISION: Keep 10 PCs");
    expect(text).toContain("OBSERVATION: Variance explained");
  });

  it("excludes hypothesis and note digest sections", () => {
    expect(text).not.toMatch(/HYPOTHESIS:/);
    expect(text).not.toMatch(/NOTE:/);
    expect(text).not.toContain("Housekeeping only");
  });

  it("includes fenced code and artifact basenames", () => {
    expect(text).toContain("```python");
    expect(text).toContain("sc.pp.pca(adata)");
    expect(text).toContain("artifacts: pca.png");
  });

  it("excludes superseded methods and preserves source ids, limitations and check warnings", () => {
    const ctx = buildMethodsDraftContext([
      entryOf({ id: "old", title: "Incorrect method" }),
      entryOf({ id: "new", timestamp: 2000, supersedes: "old", title: "Corrected method", limitations: ["Seed not recorded"], outcome: "inconclusive", evidence: [{ entryId: "h", relation: "inconclusive" }], artifactHealth: [{ path: "result.csv", status: "changed", checkedAt: 3000, reason: "Needs review" }] }),
    ], { sessionId: "s" });
    const digest = ctx.messages[0].content as string;
    expect(digest).not.toContain("METHOD: Incorrect method");
    expect(digest).toContain("source entry: new");
    expect(digest).toContain("Seed not recorded");
    expect(digest).toContain("artifact check result.csv: changed");
    expect(digest).toContain("evidence inconclusive: h");
  });

  it("shows the stance line referencing the target title", () => {
    expect(text).toContain("supports: Six populations exist");
  });
});

describe("runMethodsDraft", () => {
  it("does not spend an AI call drafting performed methods from a plan alone", async () => {
    const p = createProject({ name: "Plan only" });
    appendNotebookEntry("s", entryOf({ id: "h", type: "hypothesis" }), p.id);
    await expect(runMethodsDraft("s", p.id, {}, async () => { throw new Error("must not call model"); })).rejects.toThrow(/plan alone is not evidence/);
  });

  it("includes real frozen plans and deviations in the draft context without treating intentions as execution", async () => {
    const p = createProject({ name: "Plan context" });
    appendNotebookEntry("s", entryOf({ id: "h", type: "hypothesis" }), p.id);
    appendNotebookEntry("s", entryOf({ id: "m", timestamp: 2000 }), p.id);
    fs.writeFileSync(path.join(resolvePaths(p.id).sandbox, "data.csv"), "data");
    const source = { sessionId: "s", entryId: "h" };
    const plan = { hypothesis: "Question", primaryOutcome: "Mean score", exclusions: "QC", model: "Linear model", multiplicity: "One test", qc: "No missingness", stopping: "100 samples", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
    const preview = await previewAnalysisPlan(p.id, source, { plan, expectedHead: null });
    const history = await freezeAnalysisPlan(p.id, source, { previewId: preview.id, acknowledgeLocalFreeze: true });
    recordPlanDeviation(p.id, source, { expectedHead: history.head, planId: history.events[0].id, field: "model", actual: "Huber regression", reason: "Heavy tails", timing: "after-results" });
    await runMethodsDraft("s", p.id, {}, async (_model, context) => {
      expect(context.messages[0].content).toContain("Huber regression");
      expect(context.messages[0].content).toContain("Frozen revision 1");
      expect(context.systemPrompt).toContain("intended methods, not execution");
      return fakeMessage("## Methods\nA draft with recorded deviations.");
    });
  });

  it("drafts the methods, writes the file, and ledgers under methods-draft", async () => {
    const p = createProject({ name: "Draft" });
    appendNotebookEntry("sess-1", entryOf({ type: "method", title: "Ran PCA" }), p.id);

    const res = await withActiveProject(p.id, () =>
      runMethodsDraft("sess-1", p.id, {}, async (_model, _context, options) => {
        expect(options?.apiKey).toBeUndefined();
        return fakeMessage("## Methods\nWe ran PCA.");
      }),
    );
    expect(res.path).toBe("methods_draft_sess-1.md");
    expect(res.markdown).toContain("## Methods");
    expect(res.costUsd).toBeCloseTo(0.003);
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(20);

    const sandbox = resolvePaths(p.id).sandbox;
    const written = fs.readFileSync(path.join(sandbox, "methods_draft_sess-1.md"), "utf-8");
    expect(written).toContain("## Methods");

    const summary = withActiveProject(p.id, () =>
      sessionCostSummary(METHODS_DRAFT_SESSION_ID, p.id),
    );
    expect(summary.totalUsd).toBeCloseTo(0.003);
    expect(summary.entries[0].role).toBe("agent");
  });

  it("unwraps a whole-answer code fence", async () => {
    const p = createProject({ name: "Fence" });
    appendNotebookEntry("s", entryOf(), p.id);
    const res = await withActiveProject(p.id, () =>
      runMethodsDraft("s", p.id, {}, async () => fakeMessage("```markdown\n## Methods\nBody.\n```")),
    );
    expect(res.markdown).toBe("## Methods\nBody.");
  });

  it("throws 400 when the notebook is empty", async () => {
    const p = createProject({ name: "Empty" });
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, {}, async () => fakeMessage("x")),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 402 when the project budget is exhausted", async () => {
    const p = createProject({ name: "Broke", spendLimitUsd: 0.01 });
    appendNotebookEntry("s", entryOf(), p.id);
    // Seed spend past the limit so isBudgetExceeded trips before the model call.
    recordRun({
      sessionId: "s", projectId: p.id, model: "m",
      before: emptySnapshot(),
      after: { costUsd: 1, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, {}, async () => fakeMessage("x")),
      ),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("throws 422 for a fusion model", async () => {
    const p = createProject({ name: "Fusion" });
    appendNotebookEntry("s", entryOf(), p.id);
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, { model: "fusion/foo" }, async () => fakeMessage("x")),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("throws 502 when the model call throws", async () => {
    const p = createProject({ name: "Throw" });
    appendNotebookEntry("s", entryOf(), p.id);
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, {}, async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws 502 when the model stops with an error", async () => {
    const p = createProject({ name: "Err" });
    appendNotebookEntry("s", entryOf(), p.id);
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, {}, async () =>
          fakeMessage("x", { stopReason: "error", errorMessage: "nope" } as Partial<AssistantMessage>),
        ),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws 502 when the model returns nothing usable", async () => {
    const p = createProject({ name: "EmptyOut" });
    appendNotebookEntry("s", entryOf(), p.id);
    await expect(
      withActiveProject(p.id, () =>
        runMethodsDraft("s", p.id, {}, async () => fakeMessage("   ")),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});
