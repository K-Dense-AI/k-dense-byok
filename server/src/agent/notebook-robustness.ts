/** User-approved, bounded robustness workflows. The lead/children may propose
 * recipes, but only this local API approval path admits remote execution. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { modalConfigured } from "../config.ts";
import { listProjects, resolvePaths } from "../projects.ts";
import { jsonDigest } from "../canonical-json.ts";
import { readAnalysisPlans, validatePlanSource } from "./notebook-plans.ts";
import { readNotebookEntries, appendNewNotebookEntries, type NotebookEntry } from "./notebook-store.ts";
import { deriveEvidenceThreads } from "../../../web/src/lib/notebook-evidence-core.ts";
import { latestFrozenPlan, type PlanSource } from "../../../web/src/lib/notebook-plans.ts";
import { normalizeRobustnessDraft, parseRobustnessResult, type RobustnessPreview, type RobustnessWorkflow, type RobustnessAttempt } from "../../../web/src/lib/notebook-robustness.ts";
import { modalJobManager, DurableModalJobManager } from "../modal/manager.ts";
import { worstCaseReservationUsd, resolveInstance } from "../modal/catalog.ts";
import { modalJobFiles } from "../modal/store.ts";
import { approvedBatchDir, approvedInputRoot, batchCancelled, batchCommitted, approvedInputPlan, assertApprovedJob } from "../modal/approved.ts";
import { isTerminalModalState, ModalJobError, type ModalJob, type ModalJobRequest } from "../modal/types.ts";
import { robustnessDir, robustnessRoot, listRobustnessIds, readRobustnessPreview, sourcePath, snapshotInputs, checkSnapshotQuota, publishExclusiveJson, readManagedJson, ROBUSTNESS_TTL_MS, ROBUSTNESS_CONFIG_ROOT, ROBUSTNESS_OUTPUT_ROOT } from "./robustness-store.ts";

const preparing = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = preparing.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  preparing.set(key, next);
  try { return await next; } finally { if (preparing.get(key) === next) preparing.delete(key); }
}
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
interface Approval { previewDigest: string; approvedAt: number; maxEstimatedUsd: number }
function approval(projectId: string, preview: RobustnessPreview): Approval | undefined {
  const file = path.join(robustnessDir(projectId, preview.id), "approval.json");
  if (!fs.existsSync(file)) return;
  const value = readManagedJson<Approval>(file);
  if (value.previewDigest !== preview.digest || !Number.isFinite(value.approvedAt) || !Number.isFinite(value.maxEstimatedUsd) || value.maxEstimatedUsd < preview.totalReservationUsd) throw new ModalJobError("INVALID_RECORD", "Robustness approval is inconsistent", 503);
  return value;
}
function requestFor(preview: RobustnessPreview, job: RobustnessPreview["jobs"][number]): ModalJobRequest {
  return { command: job.command, instance: preview.draft.instance, gpuCount: 1, timeoutSec: preview.draft.timeoutSec,
    filesIn: job.filesIn, filesOut: [job.outputPath], image: { base: "python:3.13-slim", pip: preview.draft.packages }, cache: "none", groupId: preview.id, label: `${preview.draft.title}: ${job.specificationKey}`.slice(0, 200) };
}
function ownedSource(projectId: string, source: PlanSource) {
  validatePlanSource(source);
  const entries = readNotebookEntries(source.sessionId, projectId);
  const matches = entries.filter((e) => e.id === source.entryId);
  if (matches.length !== 1 || matches[0].type !== "hypothesis") throw new ModalJobError("SOURCE_MISSING", "Use a saved hypothesis for robustness analysis", 404);
  if (deriveEvidenceThreads(entries).get(source.entryId)?.supersededBy) throw new ModalJobError("SOURCE_SUPERSEDED", "Use the amended hypothesis rather than a superseded claim", 409);
  return matches[0];
}
function owns(preview: RobustnessPreview, source: PlanSource): void {
  if (preview.source.sessionId !== source.sessionId || preview.source.entryId !== source.entryId) throw new ModalJobError("WORKFLOW_NOT_FOUND", "Workflow does not belong to this notebook entry", 404);
}

export class NotebookRobustnessService {
  private unsubscribe: () => void;
  constructor(readonly manager: DurableModalJobManager, private configured: () => boolean = modalConfigured) {
    this.unsubscribe = manager.onTerminal((job) => { if (job.approval) this.harvest(job.projectId, job.approval.batchId); });
  }
  dispose() { this.unsubscribe(); }
  isConfigured() { return this.configured(); }

  async preview(projectId: string, source: PlanSource, input: unknown): Promise<RobustnessPreview> {
    return serialized(projectId, async () => {
      const entry = ownedSource(projectId, source);
      const raw = input as { draft?: unknown; planId?: unknown; expectedPlanHead?: unknown } | null;
      const history = readAnalysisPlans(projectId, source);
      const frozen = latestFrozenPlan(history);
      if (!frozen || raw?.planId !== frozen.id || raw.expectedPlanHead !== history.head) throw new ModalJobError("PLAN_CHANGED", "Select the latest frozen plan and reload its history before preparing work", 409);
      let draft;
      try { draft = normalizeRobustnessDraft(raw.draft); } catch (e) { throw new ModalJobError("INVALID_RECIPE", (e as Error).message); }
      if (!resolveInstance(draft.instance)) throw new ModalJobError("UNKNOWN_INSTANCE", "Select a resource from the Modal catalogue");
      draft.script = sourcePath(projectId, draft.script).rel;
      if (!draft.script.toLowerCase().endsWith(".py")) throw new ModalJobError("INVALID_SCRIPT", "This version runs an explicitly reviewed UTF-8 Python script");
      draft.inputs = [...new Set(draft.inputs.map((p) => sourcePath(projectId, p).rel))];
      const inputs = [...new Set([draft.script, ...draft.inputs])].sort();
      for (const dataset of frozen.plan.datasets) if (!inputs.includes(sourcePath(projectId, dataset).rel)) throw new ModalJobError("MISSING_PLAN_INPUT", `Explicitly include frozen-plan dataset ${dataset} in inputs`);
      const initialBytes = inputs.reduce((n, p) => n + fs.statSync(sourcePath(projectId, p).abs).size, 0);
      checkSnapshotQuota(projectId, initialBytes);
      const id = `rw_${crypto.randomUUID().replaceAll("-", "")}`;
      const dir = robustnessDir(projectId, id);
      fs.mkdirSync(dir, { recursive: true });
      try {
        const root = approvedInputRoot(projectId, id);
        const inputFiles = await snapshotInputs(projectId, inputs, root);
        const warnings: string[] = [];
        for (const old of frozen.datasets) {
          const current = inputFiles.find((f) => f.path === old.path);
          if (old.sha256 && current?.sha256 !== old.sha256) throw new ModalJobError("PLAN_DATA_CHANGED", `Dataset ${old.path} differs from the frozen plan. Review a plan revision first.`, 409);
          if (!old.sha256) warnings.push(`${old.path}: identity at plan freeze was unverified; only the newly reviewed snapshot is pinned now.`);
        }
        const scriptFile = path.join(root, draft.script);
        if (fs.statSync(scriptFile).size > 128 * 1024) throw new ModalJobError("SCRIPT_LIMIT", "Reviewable script must be at most 128 KiB; factor helpers into explicit input files", 413);
        let scriptSource: string;
        try { scriptSource = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(scriptFile)); }
        catch { throw new ModalJobError("INVALID_SCRIPT", "Script must be valid UTF-8"); }
        const generatedFiles: RobustnessPreview["generatedFiles"] = [];
        const jobs = draft.specifications.map((spec) => {
          const config = `${ROBUSTNESS_CONFIG_ROOT}/${id}/${spec.key}.json`;
          const bytes = JSON.stringify({ schemaVersion: 1, key: spec.key, seed: spec.seed, metric: draft.metric, unit: draft.unit, nullValue: draft.nullValue, parameters: JSON.parse(spec.parametersJson) }) + "\n";
          const target = path.join(root, config); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
          generatedFiles.push({ path: config, size: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
          const outputPath = `${ROBUSTNESS_OUTPUT_ROOT}/${id}/${spec.key}/result.json`;
          const command = `mkdir -p -- ${quote(path.posix.dirname(outputPath))}\nPYTHONHASHSEED=${spec.seed} python3 ${quote(draft.script)} --spec ${quote(config)} --output ${quote(outputPath)}`;
          return { specificationKey: spec.key, jobId: `mj_${jsonDigest([id, spec.key]).slice(0, 32)}`, command, filesIn: [...inputs, config], outputPath,
            reservationUsd: worstCaseReservationUsd({ command, instance: draft.instance, timeoutSec: draft.timeoutSec, gpuCount: 1 }) };
        });
        const payload = { version: 1 as const, projectId, id, source, sourceDigest: jsonDigest(entry), planId: frozen.id, planRevision: frozen.revision, planHead: history.head!, draft, createdAt: Date.now(), expiresAt: Date.now() + ROBUSTNESS_TTL_MS, inputFiles, generatedFiles, scriptSource, warnings, totalReservationUsd: jobs.reduce((n, j) => n + j.reservationUsd, 0), jobs };
        const preview = { ...payload, digest: jsonDigest(payload) };
        if (Buffer.byteLength(JSON.stringify(preview)) > 512 * 1024) throw new ModalJobError("PREVIEW_LIMIT", "Preview exceeds 512 KiB; shorten parameters/path lists or factor the main script into helpers", 413);
        checkSnapshotQuota(projectId, inputFiles.reduce((n, f) => n + f.size, 0), id);
        publishExclusiveJson(path.join(dir, "preview.json"), preview);
        return preview;
      } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
    });
  }

  async approve(projectId: string, source: PlanSource, id: string, input: unknown): Promise<RobustnessWorkflow> {
    const preview = readRobustnessPreview(projectId, id); owns(preview, source);
    const raw = input as { digest?: unknown; approveRemote?: unknown; reviewedScript?: unknown; acknowledgeEstimates?: unknown; acknowledgeUnverifiedPlanData?: unknown; maxEstimatedUsd?: unknown } | null;
    if (raw?.digest !== preview.digest || raw.approveRemote !== true || raw.reviewedScript !== true || raw.acknowledgeEstimates !== true) throw new ModalJobError("APPROVAL_REQUIRED", "Explicit review of the exact script/specifications, remote upload and estimated cost is required");
    if (approval(projectId, preview)) return this.get(projectId, source, id);
    if (!this.configured()) throw new ModalJobError("NOT_CONFIGURED", "Configure Modal in Settings before approving remote work", 503);
    if (Date.now() > preview.expiresAt) throw new ModalJobError("PREVIEW_EXPIRED", "Preview expired; prepare and review a new snapshot", 410);
    if (typeof raw.maxEstimatedUsd !== "number" || !Number.isFinite(raw.maxEstimatedUsd) || raw.maxEstimatedUsd < preview.totalReservationUsd) throw new ModalJobError("APPROVED_BUDGET_TOO_LOW", "Approved maximum must cover every specification's full estimated timeout", 400);
    if (preview.warnings.length && raw.acknowledgeUnverifiedPlanData !== true) throw new ModalJobError("APPROVAL_REQUIRED", "Acknowledge the unverified identities in the original frozen plan");
    const measured = await snapshotInputs(projectId, preview.inputFiles.map((f) => f.path));
    if (jsonDigest(measured) !== jsonDigest(preview.inputFiles)) throw new ModalJobError("INPUT_CHANGED", "Script or inputs changed after preview; prepare a new preview", 409);
    const sourceNow = ownedSource(projectId, source);
    if (jsonDigest(sourceNow) !== preview.sourceDigest || readAnalysisPlans(projectId, source).head !== preview.planHead) throw new ModalJobError("PLAN_CHANGED", "Hypothesis or plan history changed after preview; review again", 409);
    if (fs.existsSync(path.join(resolvePaths(projectId).sandbox, ROBUSTNESS_OUTPUT_ROOT, id))) throw new ModalJobError("OUTPUT_EXISTS", "Workflow output namespace already exists; prepare a new workflow", 409);
    // Validate retained snapshot bytes too, including generated parameter files,
    // before any budget commitment or sandbox can be created.
    const verified = new Set<string>();
    for (const job of this.items(preview)) await approvedInputPlan({ projectId, approval: job.approval } as ModalJob, verified);
    if (!this.configured()) throw new ModalJobError("NOT_CONFIGURED", "Modal credentials changed; configure them before approval", 503);
    const currentRate = worstCaseReservationUsd({ command: preview.jobs[0].command, instance: preview.draft.instance, timeoutSec: preview.draft.timeoutSec });
    if (preview.jobs.some((j) => currentRate > j.reservationUsd + 1e-12)) throw new ModalJobError("PRICE_CHANGED", "Resource pricing increased; review a new quote", 409);
    // Final context check after async verification; publication is exclusive.
    if (Date.now() > preview.expiresAt) throw new ModalJobError("PREVIEW_EXPIRED", "Preview expired during verification; review again", 410);
    if (readAnalysisPlans(projectId, source).head !== preview.planHead || jsonDigest(ownedSource(projectId, source)) !== preview.sourceDigest) throw new ModalJobError("PLAN_CHANGED", "Source changed during verification; review again", 409);
    try { publishExclusiveJson(path.join(robustnessDir(projectId, id), "approval.json"), { previewDigest: preview.digest, approvedAt: Date.now(), maxEstimatedUsd: raw.maxEstimatedUsd }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return this.get(projectId, source, id); throw e; }
    this.admit(projectId, preview);
    return this.get(projectId, source, id);
  }
  private items(preview: RobustnessPreview) {
    return preview.jobs.map((j) => ({ id: j.jobId, request: requestFor(preview, j), approval: { batchId: preview.id, maxReservationUsd: j.reservationUsd,
      inputs: [...preview.inputFiles, ...preview.generatedFiles.filter((f) => j.filesIn.includes(f.path))] } }));
  }
  private admit(projectId: string, preview: RobustnessPreview): void {
    const dir = robustnessDir(projectId, preview.id);
    if (fs.existsSync(path.join(dir, "admission-error.json")) || batchCancelled(projectId, preview.id)) return;
    try {
      appendNewNotebookEntries(preview.source.sessionId, [{ id: `robustness:${preview.id}:approval`, type: "note", title: `Approved robustness workflow: ${preview.draft.title}`, timestamp: approval(projectId, preview)!.approvedAt, role: "compute", evidence: [{ entryId: preview.source.entryId, relation: "context" }],
        body: `User approved ${preview.jobs.length} specifications against local plan revision ${preview.planRevision}. Approval is not execution: inspect each attempt's terminal status. Maximum estimated sandbox commitment $${preview.totalReservationUsd.toFixed(6)} (not an invoice cap). Workflow ${preview.id}. Script ${preview.draft.script} @ ${preview.inputFiles.find((f) => f.path === preview.draft.script)?.sha256}; image python:3.13-slim; packages ${preview.draft.packages.join(", ") || "none"}; resource ${preview.draft.instance}; timeout ${preview.draft.timeoutSec}s per specification. Metric ${preview.draft.metric}, unit ${preview.draft.unit}, null ${preview.draft.nullValue}. Sensitivity checks are not independent replications.`,
        code: { lang: "json", source: JSON.stringify({ inputs: preview.inputFiles, specifications: preview.draft.specifications, jobs: preview.jobs }, null, 2) } }], projectId);
      this.manager.submitApprovedBatch(projectId, preview.id, this.items(preview), { sessionId: preview.source.sessionId, submittedBy: "api" });
    } catch (e) {
      const error = e as Error;
      try { publishExclusiveJson(path.join(dir, "admission-error.json"), { message: error.message, recordedAt: Date.now() }); } catch (again) { if ((again as NodeJS.ErrnoException).code !== "EEXIST") throw again; }
      this.harvest(projectId, preview.id);
    }
  }
  get(projectId: string, source: PlanSource, id: string): RobustnessWorkflow {
    const preview = readRobustnessPreview(projectId, id); owns(preview, source);
    const approved = approval(projectId, preview);
    const failed = path.join(robustnessDir(projectId, id), "admission-error.json");
    const admissionError = fs.existsSync(failed) ? readManagedJson<{ message: string }>(failed).message : undefined;
    const cancelled = batchCancelled(projectId, id);
    const committed = batchCommitted(projectId, id);
    const attempts = preview.jobs.map((j): RobustnessAttempt => {
      const spec = preview.draft.specifications.find((s) => s.key === j.specificationKey)!;
      const job = this.manager.store.read(projectId, j.jobId);
      const base: RobustnessAttempt = { specification: spec, jobId: j.jobId, outputPath: j.outputPath,
        state: job?.state ?? (cancelled ? "not-started-cancelled" : admissionError ? "not-admitted" : approved ? "awaiting-admission" : "not-approved"),
        resultStatus: job && isTerminalModalState(job.state) ? "missing" : "pending", reconciled: job?.accounting.reconciled ?? (!approved || Boolean(admissionError) || cancelled),
        ...(job?.error ? { error: job.error.message } : job?.approvalCleanupUncertain ? { error: "Remote cleanup was not confirmed; full approved estimate counted against the project budget conservatively." } : admissionError ? { error: admissionError } : {}),
        ...(job?.accounting.estimatedCostUsd !== undefined ? { estimatedCostUsd: job.accounting.estimatedCostUsd } : !job && (admissionError || cancelled) ? { estimatedCostUsd: 0 } : {}) };
      if (job) {
        try { if (job.approval?.batchId !== id) throw new Error("Wrong job owner"); if (committed) assertApprovedJob(job, true); }
        catch { return { ...base, state: "record-unavailable", resultStatus: "unverified", result: undefined, estimatedCostUsd: undefined, reconciled: false, error: "Job record no longer matches its approved definition; no result or cost is attributed here." }; }
      }
      if (!job && committed) return { ...base, state: "record-unavailable", resultStatus: "unverified", reconciled: false, estimatedCostUsd: undefined, error: "Committed job record is missing or unreadable. Execution/cancellation cannot be confirmed; its budget hold is retained pending recovery.", resultReason: "No result inferred from an unavailable job record." };
      if (!job || !isTerminalModalState(job.state)) return base;
      if (job.approval?.batchId !== id) return { ...base, resultStatus: "unverified", resultReason: "Job ownership does not match this workflow" };
      const output = job.outputFiles.find((f) => f.path === j.outputPath);
      if (!output) return { ...base, resultReason: "Expected result JSON was not collected; no estimate inferred." };
      try {
        // The transfer layer retains the installed bytes in job staging. Read
        // that record, not a possibly overwritten current sandbox artifact.
        const staged = path.join(modalJobFiles(projectId, j.jobId).staging, "outputs", j.outputPath);
        const stat = fs.lstatSync(staged);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Result is unsafe or exceeds 64 KiB");
        const bytes = fs.readFileSync(staged);
        if (bytes.length !== output.size || crypto.createHash("sha256").update(bytes).digest("hex") !== output.sha256) return { ...base, resultStatus: "unverified", resultReason: "Retained output no longer matches its transfer hash" };
        const result = parseRobustnessResult(JSON.parse(bytes.toString("utf8")), preview.draft.metric, preview.draft.unit);
        return { ...base, resultStatus: "available", result };
      } catch (e) { return { ...base, resultStatus: "invalid", resultReason: (e as Error).message }; }
    });
    return { preview, ...(approved ? { approvedAt: approved.approvedAt } : {}), cancelled, ...(admissionError ? { admissionError } : {}), attempts };
  }
  list(projectId: string, source: PlanSource): { workflows: RobustnessWorkflow[]; errors: string[]; configured: boolean } {
    validatePlanSource(source);
    const workflows: RobustnessWorkflow[] = []; const errors: string[] = [];
    for (const id of listRobustnessIds(projectId)) {
      try {
        const preview = readRobustnessPreview(projectId, id);
        if (preview.source.sessionId !== source.sessionId || preview.source.entryId !== source.entryId) continue;
        // Unapproved previews are returned directly from preparation, not a
        // research attempt. Keep the history focused on approved work.
        if (!approval(projectId, preview)) continue;
        this.harvest(projectId, id);
        workflows.push(this.get(projectId, source, id));
      } catch (e) { errors.push(`${id}: ${(e as Error).message}`); }
    }
    return { workflows: workflows.sort((a, b) => b.preview.createdAt - a.preview.createdAt), errors, configured: this.configured() };
  }
  async cancel(projectId: string, source: PlanSource, id: string) {
    const preview = readRobustnessPreview(projectId, id); owns(preview, source);
    if (!approval(projectId, preview)) throw new ModalJobError("NOT_APPROVED", "This preview has not been approved", 409);
    await this.manager.cancelApprovedBatch(projectId, id);
    this.harvest(projectId, id);
    return this.get(projectId, source, id);
  }
  private harvest(projectId: string, id: string): void {
    const preview = readRobustnessPreview(projectId, id);
    if (!approval(projectId, preview)) return;
    const workflow = this.get(projectId, preview.source, id);
    const entries: NotebookEntry[] = [];
    for (const a of workflow.attempts) {
      if (["queued", "preparing", "running", "collecting", "awaiting-admission", "not-approved", "record-unavailable"].includes(a.state)) continue;
      const job = this.manager.store.read(projectId, a.jobId);
      entries.push({ id: `robustness:${id}:${a.specification.key}`, role: "compute", type: "observation", title: `Robustness ${a.specification.label}: ${a.state}`, timestamp: job?.finishedAt ?? Date.now(), outcome: a.state === "succeeded" ? "inconclusive" : "technical-failure", evidence: [{ entryId: preview.source.entryId, relation: "context" }],
        body: `Workflow ${id}; job ${a.jobId}. Rationale: ${a.specification.rationale}. Seed ${a.specification.seed}. Parameters: ${a.specification.parametersJson}. Result: ${a.resultStatus}${a.result ? `; ${a.result.metric} = ${a.result.estimate ?? "not estimated"} ${a.result.unit}; QC ${a.result.qc}${a.result.interval ? `; interval [${a.result.interval.low}, ${a.result.interval.high}] at level ${a.result.interval.level}` : "; interval not provided"}${a.result.sampleSize ? `; n=${a.result.sampleSize}` : ""}` : ""}. Script ${preview.draft.script}; resource ${preview.draft.instance}. ${a.resultReason ?? a.error ?? ""} ${a.result?.notes ?? ""} This is a sensitivity analysis, not independent replication or a verdict on the hypothesis.`, 
        ...(job?.outputFiles.some((f) => f.path === a.outputPath) ? {
          artifacts: [a.outputPath],
          // Unlike a child's retrospective hash, Modal records these exact
          // collected bytes at write time. Preserve that output identity even
          // when this system note is recovered after a restart.
          artifactSnapshots: job.outputFiles.filter((f) => f.path === a.outputPath).map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, capturedAt: job.finishedAt!, timing: "output" as const })),
        } : {}) });
    }
    appendNewNotebookEntries(preview.source.sessionId, entries, projectId);
  }
  async recoverAll(): Promise<void> {
    for (const project of listProjects()) for (const id of listRobustnessIds(project.id)) {
      try {
        const preview = readRobustnessPreview(project.id, id);
        if (!approval(project.id, preview)) continue;
        if (batchCancelled(project.id, id)) await this.manager.cancelApprovedBatch(project.id, id);
        else if (!batchCommitted(project.id, id) && this.configured()) this.admit(project.id, preview);
        this.harvest(project.id, id);
      } catch (e) { console.warn("[notebook robustness] recovery requires review", id, e); }
    }
  }
}
export const notebookRobustness = new NotebookRobustnessService(modalJobManager);
