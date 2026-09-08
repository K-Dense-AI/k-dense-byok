import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths, updateProject } from "../src/projects.ts";
import { listComputeReservations, projectCostSummary } from "../src/cost/ledger.ts";
import { appendNotebookEntry, readNotebookEntries } from "../src/agent/notebook-store.ts";
import { previewAnalysisPlan, freezeAnalysisPlan } from "../src/agent/notebook-plans.ts";
import { NotebookRobustnessService } from "../src/agent/notebook-robustness.ts";
import { robustnessDir } from "../src/agent/robustness-store.ts";
import { DurableModalJobManager } from "../src/modal/manager.ts";
import { approvedBatchDir, approvedInputRoot } from "../src/modal/approved.ts";
import { modalJobFiles } from "../src/modal/store.ts";
import { summarizeRobustness, type RobustnessDraft, type RobustnessPreview } from "../../web/src/lib/notebook-robustness.ts";
import { RobustnessFakeModal } from "./helpers/robustness-modal.ts";

const source = { sessionId: "science", entryId: "h" };
const draft: RobustnessDraft = { title: "Normalization sensitivity", script: "analysis.py", inputs: ["data.csv"], metric: "difference", unit: "score", nullValue: 0, instance: "cpu-2", timeoutSec: 600, packages: [], specifications: [
  { key: "baseline", label: "Baseline", rationale: "Original prespecified fit", seed: 42, parametersJson: '{"effect":1}' },
  { key: "adjusted", label: "Site adjusted", rationale: "Assess sensitivity to the site covariate", seed: 42, parametersJson: '{"effect":-1}' },
] };
let fake: RobustnessFakeModal;
let manager: DurableModalJobManager;
let service: NotebookRobustnessService;
let project: string;
let head: string;
let planId: string;
let configured = true;
beforeEach(async () => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  project = createProject({ name: "Robustness", projectId: "study" }).id;
  appendNotebookEntry(source.sessionId, { id: source.entryId, role: "agent", type: "hypothesis", title: "Question", timestamp: 1 }, project);
  const root = resolvePaths(project).sandbox;
  fs.writeFileSync(path.join(root, "data.csv"), "x\n1\n2\n");
  fs.writeFileSync(path.join(root, "analysis.py"), "# Trusted test fixture; fake adapter never executes it.\nprint('analysis')\n");
  const plan = { hypothesis: "Question", primaryOutcome: "Difference", exclusions: "None", model: "Linear", multiplicity: "One test", qc: "Complete data", stopping: "Fixed n", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
  const p = await previewAnalysisPlan(project, source, { plan, expectedHead: null });
  const h = await freezeAnalysisPlan(project, source, { previewId: p.id, acknowledgeLocalFreeze: true });
  head = h.head!; planId = h.events[0].id;
  fake = new RobustnessFakeModal(); manager = new DurableModalJobManager(fake.factory); configured = true;
  service = new NotebookRobustnessService(manager, () => configured);
});
afterEach(async () => { await manager.cancelProject(project); service.dispose(); vi.restoreAllMocks(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });
const prepare = (value = draft) => service.preview(project, source, { draft: value, planId, expectedPlanHead: head });
const consent = (p: RobustnessPreview) => ({ digest: p.digest, approveRemote: true, reviewedScript: true, acknowledgeEstimates: true, acknowledgeUnverifiedPlanData: true, maxEstimatedUsd: p.totalReservationUsd });
const approve = (p: RobustnessPreview) => service.approve(project, source, p.id, consent(p));
const wait = async (p: RobustnessPreview) => { await Promise.all(p.jobs.map((j) => manager.wait(project, j.jobId, 5000))); return service.get(project, source, p.id); };

describe("bounded robustness workflows", () => {
  it("previews exact snapshots and quotes without admitting work or reserving money", async () => {
    const p = await prepare();
    expect(p.inputFiles).toHaveLength(2); expect(p.generatedFiles).toHaveLength(2);
    expect(p.totalReservationUsd).toBeCloseTo(2 * 0.1 / 6);
    expect(p.scriptSource).toContain("Trusted test fixture");
    expect(fake.prepared).toBe(0); expect(manager.list(project)).toEqual([]); expect(listComputeReservations(project)).toEqual([]);
    await expect(service.approve(project, source, p.id, { digest: p.digest })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(manager.list(project)).toEqual([]);
  });
  it("admits once, verifies uploaded bytes, uses snapshots and retains recorded outputs", async () => {
    const p = await prepare();
    const first = await approve(p);
    expect(first.approvedAt).toBeDefined(); expect(listComputeReservations(project)).toHaveLength(2);
    fs.writeFileSync(path.join(resolvePaths(project).sandbox, "data.csv"), "changed after approval");
    await approve(p); // lost-response retry must never create another batch
    const result = await wait(p);
    expect(fake.created).toBe(2); expect(fake.verifications).toBe(2); expect(fake.executions).toBe(2);
    expect(summarizeRobustness(result.attempts)).toMatchObject({ eligible: 2, min: -1, max: 1, median: 0 });
    expect(listComputeReservations(project)).toEqual([]);
    const original = result.attempts[0].result;
    fs.writeFileSync(path.join(resolvePaths(project).sandbox, result.attempts[0].outputPath), '{"estimate":9999}');
    expect(service.get(project, source, p.id).attempts[0].result).toEqual(original);
    expect(readNotebookEntries(source.sessionId, project).filter((e) => e.id.startsWith(`robustness:${p.id}`))).toHaveLength(3);
    service.list(project, source); service.list(project, source);
    expect(readNotebookEntries(source.sessionId, project).filter((e) => e.id.startsWith(`robustness:${p.id}`))).toHaveLength(3);
  });
  it("rejects changed originals and retained snapshots before spending", async () => {
    const p = await prepare(); const script = path.join(resolvePaths(project).sandbox, "analysis.py");
    const original = fs.readFileSync(script); fs.writeFileSync(script, "changed");
    await expect(approve(p)).rejects.toMatchObject({ code: "INPUT_CHANGED" });
    fs.writeFileSync(script, original);
    fs.writeFileSync(path.join(approvedInputRoot(project, p.id), "analysis.py"), "changed snapshot");
    await expect(approve(p)).rejects.toMatchObject({ code: "INPUT_CHANGED" });
    expect(fake.created).toBe(0); expect(listComputeReservations(project)).toEqual([]);
  });
  it("requires a current frozen-plan head and unchanged known plan datasets", async () => {
    await expect(service.preview(project, source, { draft, planId, expectedPlanHead: "stale" })).rejects.toMatchObject({ code: "PLAN_CHANGED" });
    fs.writeFileSync(path.join(resolvePaths(project).sandbox, "data.csv"), "different dataset");
    await expect(prepare()).rejects.toMatchObject({ code: "PLAN_DATA_CHANGED" });
    expect(fake.created).toBe(0);
  });
  it("does not accept expired, under-budget or unconfigured approvals", async () => {
    const p = await prepare(); configured = false;
    await expect(approve(p)).rejects.toMatchObject({ code: "NOT_CONFIGURED" }); configured = true;
    await expect(service.approve(project, source, p.id, { ...consent(p), maxEstimatedUsd: 0 })).rejects.toMatchObject({ code: "APPROVED_BUDGET_TOO_LOW" });
    const now = vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    await expect(approve(p)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" }); now.mockRestore();
    expect(fake.created).toBe(0);
  });
  it("rejects unsafe paths, duplicate variations, dynamic package installs and missing plan inputs", async () => {
    await expect(prepare({ ...draft, script: "../escape.py" })).rejects.toThrow();
    await expect(prepare({ ...draft, inputs: [] })).rejects.toMatchObject({ code: "MISSING_PLAN_INPUT" });
    await expect(prepare({ ...draft, packages: ["numpy"] })).rejects.toMatchObject({ code: "INVALID_RECIPE" });
    await expect(prepare({ ...draft, specifications: [draft.specifications[0], draft.specifications[0]] })).rejects.toMatchObject({ code: "INVALID_RECIPE" });
    expect(fake.created).toBe(0);
  });
  it("rejects concurrent duplicate approvals without duplicate jobs or holds", async () => {
    const p = await prepare(); await Promise.all([approve(p), approve(p)]); await wait(p);
    expect(manager.list(project)).toHaveLength(2); expect(fake.created).toBe(2);
  });
  it("checks the whole budget before starting any sandbox and records every unadmitted specification", async () => {
    updateProject(project, { spendLimitUsd: 0.02 });
    const p = await prepare(); const w = await approve(p);
    expect(w.admissionError).toMatch(/spend limit/); expect(w.attempts.map((a) => a.state)).toEqual(["not-admitted", "not-admitted"]);
    expect(fake.prepared).toBe(0); expect(fake.created).toBe(0); expect(listComputeReservations(project)).toEqual([]); expect(projectCostSummary(project).totalUsd).toBe(0);
    expect(readNotebookEntries(source.sessionId, project).filter((e) => e.id.startsWith(`robustness:${p.id}`))).toHaveLength(3);
  });
  it("does not start a partial batch if durable job creation fails", async () => {
    const create = manager.store.create.bind(manager.store); let count = 0;
    vi.spyOn(manager.store, "create").mockImplementation((job) => { if (++count === 2) throw new Error("simulated disk failure"); return create(job); });
    const p = await prepare(); const w = await approve(p);
    expect(w.admissionError).toMatch(/disk failure/); expect(w.attempts).toHaveLength(2);
    expect(fake.prepared).toBe(0); expect(listComputeReservations(project)).toEqual([]);
  });
  it("retains nonzero exits, invalid/missing outputs and QC failures without inventing estimates", async () => {
    fake.behaviors = { baseline: "fail", adjusted: "invalid", missing: "missing", qc: "qc-fail" };
    const p = await prepare({ ...draft, specifications: [...draft.specifications, { ...draft.specifications[0], key: "missing" }, { ...draft.specifications[0], key: "qc" }] });
    await approve(p); const w = await wait(p);
    expect(w.attempts.map((a) => [a.state, a.resultStatus])).toEqual([["failed", "available"], ["succeeded", "invalid"], ["succeeded", "missing"], ["succeeded", "available"]]);
    expect(w.attempts[3].result).toMatchObject({ qc: "fail" }); expect(w.attempts[3].result?.estimate).toBeUndefined();
    expect(summarizeRobustness(w.attempts).eligible).toBe(0);
  });
  it("refuses altered uploads before executing science and bounds output downloads", async () => {
    fake.tamperUpload = true; const p = await prepare(); await approve(p); const w = await wait(p);
    expect(fake.executions).toBe(0); expect(w.attempts.every((a) => a.state === "failed")).toBe(true);
    fake.tamperUpload = false; fake.behaviors = { baseline: "oversized" };
    const p2 = await prepare(); await approve(p2); const w2 = await wait(p2);
    expect(w2.attempts[0].state).toBe("failed"); expect(w2.attempts[0].result).toBeUndefined();
  });
  it("cancels all remaining managed attempts and forbids direct retries", async () => {
    fake.behaviors = { baseline: "hang", adjusted: "hang" }; const p = await prepare(); await approve(p);
    await vi.waitFor(() => expect(fake.executions).toBe(2));
    const w = await service.cancel(project, source, p.id);
    expect(w.cancelled).toBe(true); expect(w.attempts.every((a) => a.state === "cancelled")).toBe(true);
    expect(listComputeReservations(project)).toEqual([]);
    expect(() => manager.retry(project, p.jobs[0].jobId)).toThrow(/new robustness workflow/);
  });
  it("charges uncertain launches conservatively and never automatically retries them", async () => {
    fake.createError = true; const p = await prepare(); await approve(p); const w = await wait(p);
    expect(w.attempts.every((a) => a.state === "failed")).toBe(true);
    expect(projectCostSummary(project).totalUsd).toBeCloseTo(p.totalReservationUsd);
    await manager.recoverProject(project); await service.recoverAll();
    expect(fake.created).toBe(2); expect(fake.executions).toBe(0);
  });
  it("charges unconfirmed cleanup conservatively rather than claiming it stopped", async () => {
    fake.terminationError = true; const p = await prepare(); await approve(p); await wait(p);
    expect(projectCostSummary(project).totalUsd).toBeCloseTo(p.totalReservationUsd);
    expect(manager.get(project, p.jobs[0].jobId).approvalCleanupUncertain).toBe(true);
  });
  it("recovers committed queued batches, but does not relaunch an interrupted preparing job", async () => {
    const noSchedule = vi.spyOn(manager as any, "schedule").mockImplementation(() => {});
    const p = await prepare(); await approve(p); expect(fake.created).toBe(0);
    manager.store.transition(project, p.jobs[0].jobId, "preparing");
    noSchedule.mockRestore(); service.dispose();
    manager = new DurableModalJobManager(fake.factory); service = new NotebookRobustnessService(manager, () => true);
    await manager.recoverProject(project); await service.recoverAll(); const w = await wait(p);
    expect(w.attempts[0].state).toBe("lost"); expect(w.attempts[1].state).toBe("succeeded");
    expect(fake.created).toBe(1); expect(fake.executions).toBe(1);
    expect(w.attempts[0].estimatedCostUsd).toBeCloseTo(p.jobs[0].reservationUsd);
  });
  it("holds uncommitted jobs on manager recovery until the complete batch is admitted", async () => {
    const noSchedule = vi.spyOn(manager as any, "schedule").mockImplementation(() => {});
    const p = await prepare(); await approve(p);
    fs.unlinkSync(path.join(approvedBatchDir(project, p.id), "committed.json"));
    noSchedule.mockRestore(); service.dispose();
    manager = new DurableModalJobManager(fake.factory); service = new NotebookRobustnessService(manager, () => true);
    await manager.recoverProject(project); expect(fake.created).toBe(0);
    await service.recoverAll(); const w = await wait(p);
    expect(w.attempts.every((a) => a.state === "succeeded")).toBe(true); expect(fake.created).toBe(2);
  });
  it("retains budget holds and never recreates a missing committed job record", async () => {
    const noSchedule = vi.spyOn(manager as any, "schedule").mockImplementation(() => {});
    const p = await prepare(); await approve(p);
    fs.writeFileSync(modalJobFiles(project, p.jobs[0].jobId).job, "corrupted record");
    noSchedule.mockRestore(); service.dispose();
    manager = new DurableModalJobManager(fake.factory); service = new NotebookRobustnessService(manager, () => true);
    await manager.recoverProject(project); await service.recoverAll();
    await manager.wait(project, p.jobs[1].jobId, 5000);
    const result = service.get(project, source, p.id);
    expect(result.attempts[0].state).toBe("record-unavailable"); expect(result.attempts[0].result).toBeUndefined();
    expect(listComputeReservations(project).map((r) => r.id)).toContain(p.jobs[0].jobId);
    expect(fake.created).toBe(1);
  });
  it("does not accept copied authorizations in a different project", async () => {
    const p = await prepare();
    const other = createProject({ name: "Other", projectId: "other" }).id;
    fs.cpSync(robustnessDir(project, p.id), robustnessDir(other, p.id), { recursive: true });
    expect(() => service.get(other, source, p.id)).toThrow(/inconsistent/);
    expect(fake.created).toBe(0);
  });

  it("never treats corrupted retained outputs or preview records as verified absence", async () => {
    const p = await prepare(); await approve(p); await wait(p);
    fs.writeFileSync(path.join(modalJobFiles(project, p.jobs[0].jobId).staging, "outputs", p.jobs[0].outputPath), "tampered");
    expect(service.get(project, source, p.id).attempts[0].resultStatus).toBe("unverified");
    fs.writeFileSync(path.join(robustnessDir(project, p.id), "preview.json"), "corrupt");
    expect(service.list(project, source).errors).toHaveLength(1);
  });
});
