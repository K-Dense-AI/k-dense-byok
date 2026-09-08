import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { appendNotebookEntry, readNotebookEntries } from "../src/agent/notebook-store.ts";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { previewAnalysisPlan, freezeAnalysisPlan, recordPlanDeviation, readAnalysisPlans, planDirectory, PLAN_PREVIEW_TTL_MS } from "../src/agent/notebook-plans.ts";
import { withNotebookPlanHistory } from "../src/agent/notebook-research.ts";
import type { AnalysisPlanInput } from "../../web/src/lib/notebook-plans.ts";

const source = { sessionId: "session-a", entryId: "hypothesis-a" };
const plan: AnalysisPlanInput = {
  hypothesis: "Treatment changes the primary outcome", primaryOutcome: "Difference in mean score at day 7",
  exclusions: "Exclude only predeclared QC failures", model: "Linear model adjusted for site",
  multiplicity: "One primary test; BH for secondary endpoints", qc: "No missing primary outcomes",
  stopping: "Fixed sample size of 100", exposureNotes: "Metadata only; outcomes have not been inspected",
  datasets: ["data.csv"], intent: "confirmatory", priorExposure: "metadata-only",
};
function setup(project = "default") {
  appendNotebookEntry(source.sessionId, { id: source.entryId, type: "hypothesis", title: "Test hypothesis", timestamp: 1, role: "agent" }, project);
  const file = path.join(resolvePaths(project).sandbox, "data.csv");
  fs.writeFileSync(file, "id,score\na,3\n");
  return file;
}
const preview = (project = "default", extra: object = {}) => previewAnalysisPlan(project, source, { plan, expectedHead: null, ...extra });
async function freeze(project = "default") {
  const p = await preview(project);
  return freezeAnalysisPlan(project, source, { previewId: p.id, acknowledgeLocalFreeze: true });
}
beforeEach(() => { vi.useRealTimers(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); });

describe("immutable analysis plans", () => {
  it("requires explicit approval, freezes exact reviewed fields and server-measured identities", async () => {
    setup();
    const p = await preview("default", { actor: "fake", recordedAt: 7, digest: "fake" });
    expect(p.datasets[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(freezeAnalysisPlan("default", source, { previewId: p.id })).rejects.toMatchObject({ statusCode: 400 });
    const h = await freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true, plan: { model: "INJECTED" }, actor: "model", recordedAt: 7 });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: "freeze", revision: 1, plan, actor: "user", source });
    expect(h.events[0].recordedAt).not.toBe(7);
    expect(readAnalysisPlans("default", source)).toEqual(h);
  });
  it("is idempotent after a lost freeze response", async () => {
    setup(); const p = await preview();
    const body = { previewId: p.id, acknowledgeLocalFreeze: true };
    const first = await freezeAnalysisPlan("default", source, body);
    expect(await freezeAnalysisPlan("default", source, body)).toEqual(first);
  });
  it("detects dataset changes between preview and approval, without creating an event", async () => {
    const file = setup(); const p = await preview(); fs.writeFileSync(file, "changed");
    await expect(freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(readAnalysisPlans("default", source).events).toHaveLength(0);
  });
  it("requires a separate acknowledgment for absent/unverified datasets", async () => {
    const file = setup(); fs.unlinkSync(file); const p = await preview();
    expect(p.datasets[0].reason).toBe("missing");
    await expect(freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true })).rejects.toMatchObject({ statusCode: 400 });
    const h = await freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true, acknowledgeUnverified: true });
    expect(h.events[0]).toMatchObject({ kind: "freeze", acknowledgedUnverified: true, datasets: [{ reason: "missing" }] });
  });
  it("rejects expired or cross-project previews", async () => {
    setup(); setup("other"); const p = await preview();
    await expect(freezeAnalysisPlan("other", source, { previewId: p.id, acknowledgeLocalFreeze: true })).rejects.toMatchObject({ statusCode: 410 });
    vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    try { await expect(freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true })).rejects.toMatchObject({ statusCode: 410 }); }
    finally { vi.restoreAllMocks(); }
    expect(p.expiresAt - p.createdAt).toBeLessThanOrEqual(PLAN_PREVIEW_TTL_MS + 10);
  });
  it("preserves revisions byte-for-byte and requires a revision reason", async () => {
    setup(); const first = await freeze();
    const file = path.join(planDirectory("default", source), "000001.json"); const bytes = fs.readFileSync(file, "utf8");
    await expect(preview("default", { expectedHead: first.head })).rejects.toMatchObject({ statusCode: 400 });
    const p = await preview("default", { expectedHead: first.head, plan: { ...plan, model: "Robust linear model" }, revisionReason: "Heavy-tailed residuals in exploratory diagnostics" });
    const second = await freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true });
    expect(second.events).toHaveLength(2);
    expect(second.events[1]).toMatchObject({ kind: "freeze", revision: 2, previousDigest: first.head });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
  it("only admits one concurrent freeze from different previews of the same head", async () => {
    setup(); const [a, b] = await Promise.all([preview(), preview()]);
    const results = await Promise.allSettled([a, b].map((p) => freezeAnalysisPlan("default", source, { previewId: p.id, acknowledgeLocalFreeze: true })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(readAnalysisPlans("default", source).events).toHaveLength(1);
  });
  it("prevents lost updates across separate server processes", async () => {
    setup(); const first = await freeze();
    const input = { expectedHead: first.head, planId: first.events[0].id, field: "model", actual: "Robust model", reason: "Sensitivity check", timing: "after-results" };
    const moduleUrl = new URL("../src/agent/notebook-plans.ts", import.meta.url).href;
    const code = `import { recordPlanDeviation } from ${JSON.stringify(moduleUrl)}; try { recordPlanDeviation("default", ${JSON.stringify(source)}, ${JSON.stringify(input)}); console.log("saved"); } catch(e) { console.log(e.statusCode === 409 ? "conflict" : "error:" + e.message); }`;
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, KADY_PROJECTS_ROOT: PROJECTS_ROOT }, timeout: 15000 });
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.stdout.trim()).sort()).toEqual(["conflict", "saved"]);
    expect(readAnalysisPlans("default", source).events).toHaveLength(2);
  });

  it("appends deviations/corrections against a specific revision; planned values are server-derived", async () => {
    setup(); const first = await freeze(); const planId = first.events[0].id;
    const second = recordPlanDeviation("default", source, { expectedHead: first.head, planId, field: "model", actual: "Robust regression", reason: "Heavy tails", timing: "after-results", planned: "forged", actor: "agent" });
    expect(second.events[1]).toMatchObject({ kind: "deviation", planned: plan.model, actor: "user", timing: "after-results" });
    const third = recordPlanDeviation("default", source, { expectedHead: second.head, planId, field: "model", actual: "Huber regression", reason: "Clarifying exact method", timing: "after-results", corrects: second.events[1].id });
    expect(third.events.slice(0, 2)).toEqual(second.events);
    expect(third.events[2]).toMatchObject({ corrects: second.events[1].id });
    expect(() => recordPlanDeviation("default", source, { expectedHead: second.head, planId, field: "model", actual: "x", reason: "x", timing: "unknown" })).toThrow(/history changed/);
    expect(() => recordPlanDeviation("default", source, { expectedHead: third.head, planId, field: "qc", actual: "x", reason: "x", timing: "unknown", corrects: second.events[1].id })).toThrow(/same plan and field/);
  });
  it("never silently resets a corrupt or gapped history", async () => {
    setup(); await freeze();
    const file = path.join(planDirectory("default", source), "000001.json");
    fs.writeFileSync(file, "{broken");
    expect(() => readAnalysisPlans("default", source)).toThrow(/not reset/);
    const enriched = withNotebookPlanHistory(readNotebookEntries(source.sessionId), "default", source.sessionId);
    expect(enriched[0].planHistoryError).toMatch(/not reset/);
    expect(enriched[0].planHistory).toBeUndefined();
    fs.renameSync(file, path.join(path.dirname(file), "000002.json"));
    expect(() => readAnalysisPlans("default", source)).toThrow(/not reset/);
  });
  it("rejects unsafe paths, incomplete plans and invalid sources", async () => {
    setup();
    await expect(preview("default", { plan: { ...plan, datasets: ["../escape.csv"] } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(preview("default", { plan: { ...plan, model: " " } })).rejects.toMatchObject({ statusCode: 400 });
    expect(() => readAnalysisPlans("default", { sessionId: "../escape", entryId: "h" })).toThrow(/Invalid/);
    await expect(previewAnalysisPlan("default", { ...source, entryId: "not-saved" }, { plan, expectedHead: null })).rejects.toMatchObject({ statusCode: 404 });
  });
  it.skipIf(process.platform === "win32")("rejects dataset symlink escapes", async () => {
    const file = setup(); fs.unlinkSync(file);
    const outside = path.join(PROJECTS_ROOT, "outside.csv"); fs.writeFileSync(outside, "secret"); fs.symlinkSync(outside, file);
    await expect(preview()).rejects.toMatchObject({ statusCode: 400 });
  });
  it.skipIf(process.platform === "win32")("rejects plan-storage symlinks into another project", () => {
    setup(); setup("other");
    const target = path.join(resolvePaths("other").notebookDir, "plans"); fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(resolvePaths("default").notebookDir, "plans"));
    expect(() => readAnalysisPlans("default", source)).toThrow(/leaves the project/);
  });

  it("a notebook-tool proposal cannot forge an approval or result snapshot", async () => {
    const tool = makeNotebookTool("default", () => source.sessionId);
    await tool.execute(source.entryId, { type: "hypothesis", title: "Draft", analysisPlan: { ...plan, approved: true }, planHistory: { events: [{ kind: "freeze" }] }, resultSnapshots: [{ sha256: "fake" }] } as never, undefined as never);
    const [entry] = readNotebookEntries(source.sessionId);
    expect(entry.analysisPlan).toEqual(plan);
    expect(entry.planHistory).toBeUndefined(); expect(entry.resultSnapshots).toBeUndefined();
    expect(readAnalysisPlans("default", source).events).toHaveLength(0);
  });
});
