/** Immutable, locally user-approved analysis plans and append-only deviations.
 * Each event is an exclusively linked file: concurrent writers targeting the
 * same head cannot overwrite one another, even across server processes. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { jsonDigest as planDigest } from "../canonical-json.ts";
export { jsonDigest as planDigest } from "../canonical-json.ts";
import { resolvePaths } from "../projects.ts";
import { apiRelative, isUserVisible, isWithin, SandboxError } from "../sandbox-fs.ts";
import { isValidSessionId, readNotebookEntries, type NotebookEntry } from "./notebook-store.ts";
import { captureNotebookArtifacts } from "./notebook-artifacts.ts";
import {
  normalizeAnalysisPlan, planFieldValue, PLAN_TEXT_FIELDS,
  type AnalysisPlanEvent, type AnalysisPlanHistory, type AnalysisPlanPreview,
  type PlanSource, type PlanDatasetIdentity, type PlanDeviationInput, type FrozenPlanEvent,
} from "../../../web/src/lib/notebook-plans.ts";

export const PLAN_PREVIEW_TTL_MS = 15 * 60_000;
export const MAX_PLAN_EVENTS = 256;
const MAX_RECORD_BYTES = 128 * 1024;

export function validatePlanSource(source: PlanSource): void {
  if (!source || typeof source.sessionId !== "string" || !isValidSessionId(source.sessionId) || source.sessionId.length > 200 || typeof source.entryId !== "string" || !source.entryId.trim() || source.entryId.length > 500) throw new SandboxError(400, "Invalid notebook plan source");
}
export function planDirectory(projectId: string, source: PlanSource): string {
  validatePlanSource(source);
  const paths = resolvePaths(projectId);
  const target = path.join(paths.notebookDir, "plans", planDigest(source));
  if (fs.existsSync(paths.sandbox)) {
    let ancestor = target;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (!isWithin(fs.realpathSync(paths.sandbox), fs.realpathSync(ancestor))) throw new SandboxError(403, "Plan storage leaves the project sandbox through a symlink");
  }
  return target;
}
function savedSource(projectId: string, source: PlanSource): NotebookEntry {
  planDirectory(projectId, source); // also reject metadata-directory symlink escapes before reading
  const entries = readNotebookEntries(source.sessionId, projectId).filter((e) => e.id === source.entryId);
  if (entries.length !== 1 || entries[0].type !== "hypothesis") throw new SandboxError(404, "Plan source must be one saved hypothesis entry");
  return entries[0];
}
function readJson(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error("Invalid or oversized plan record");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
/** fsync data then publish exclusively: a reader never sees a partially written event. */
function publish(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const encoded = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new SandboxError(413, "Plan record too large");
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, encoded, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(tmp, file);
    // Best-effort directory durability; Windows does not support directory fsync.
    let directoryFd: number | undefined;
    try { directoryFd = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(directoryFd); }
    catch { /* data is synced and the exclusive link already committed */ }
    finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
function validIdentities(value: unknown): value is PlanDatasetIdentity[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every((v) => v && typeof v.path === "string" && Number.isFinite(v.capturedAt) && (!v.sha256 || /^[a-f0-9]{64}$/.test(v.sha256)));
}
export function readAnalysisPlans(projectId: string, source: PlanSource): AnalysisPlanHistory {
  const dir = planDirectory(projectId, source);
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{6}\.json$/.test(f)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source, head: null, events: [] }; throw error; }
  if (files.length > MAX_PLAN_EVENTS) throw new SandboxError(413, "Analysis-plan history exceeds its record limit");
  try { return validateAnalysisPlanRecords(source, files.map((name) => ({ name, value: readJson(path.join(dir, name)) }))); }
  catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError(503, `Analysis-plan record is unreadable or inconsistent; it was not reset: ${(error as Error).message}`);
  }
}

/** Shared validation for bounded asynchronous memory reads and normal plan APIs. */
export function validateAnalysisPlanRecords(source: PlanSource, records: { name: string; value: unknown }[]): AnalysisPlanHistory {
  if (records.length > MAX_PLAN_EVENTS) throw new SandboxError(413, "Analysis-plan history exceeds its record limit");
  const events: AnalysisPlanEvent[] = [];
  let head: string | null = null;
  try {
    for (const [index, record] of records.entries()) {
      const file = record.name;
      const event = record.value as AnalysisPlanEvent;
      const { digest, ...unsigned } = event;
      if (event.version !== 1 || event.sequence !== index + 1 || file !== `${String(index + 1).padStart(6, "0")}.json` || event.previousDigest !== head || planDigest(event.source) !== planDigest(source) || event.actor !== "user" || !Number.isFinite(event.recordedAt) || typeof event.id !== "string" || planDigest(unsigned) !== digest) throw new Error("Invalid plan event chain");
      if (event.kind === "freeze") {
        normalizeAnalysisPlan(event.plan);
        if (!validIdentities(event.datasets) || event.revision !== events.filter((e) => e.kind === "freeze").length + 1) throw new Error("Invalid frozen revision");
      } else if (event.kind === "deviation") {
        const normalized = normalizeDeviation(event);
        if (!events.some((e) => e.kind === "freeze" && e.id === normalized.planId) || typeof event.planned !== "string") throw new Error("Invalid deviation reference");
      } else throw new Error("Unsupported plan event");
      events.push(event); head = digest;
    }
  } catch (error) {
    throw new SandboxError(503, `Analysis-plan record is unreadable or inconsistent; it was not reset: ${(error as Error).message}`);
  }
  return { source, head, events };
}
function checkHead(history: AnalysisPlanHistory, expected: unknown): void {
  if (expected !== history.head) throw new SandboxError(409, "Plan history changed. Reload and review again before saving.");
}
async function identities(projectId: string, datasets: string[]): Promise<PlanDatasetIdentity[]> {
  const snapshots = await captureNotebookArtifacts(projectId, datasets);
  if (snapshots.some((s) => s.reason === "unsafe-path")) throw new SandboxError(400, "Dataset paths must be user-visible sandbox files without symlink escapes");
  return snapshots.map(({ timing: _timing, ...identity }) => identity);
}
export async function previewAnalysisPlan(projectId: string, source: PlanSource, input: unknown): Promise<AnalysisPlanPreview> {
  const entry = savedSource(projectId, source);
  const raw = input as { plan?: unknown; expectedHead?: unknown; revisionReason?: unknown } | null;
  const history = readAnalysisPlans(projectId, source);
  checkHead(history, raw?.expectedHead);
  let plan;
  try { plan = normalizeAnalysisPlan(raw?.plan); } catch (error) { throw new SandboxError(400, (error as Error).message); }
  const sandbox = resolvePaths(projectId).sandbox;
  plan.datasets = [...new Set(plan.datasets.map((p) => {
    const abs = path.resolve(sandbox, p);
    if (!isWithin(sandbox, abs) || abs === sandbox || !isUserVisible(abs, sandbox) || p.includes("\0")) throw new SandboxError(400, "Dataset paths must stay in the visible sandbox");
    return apiRelative(sandbox, abs);
  }))];
  const revisionReason = typeof raw?.revisionReason === "string" ? raw.revisionReason.trim() : "";
  if (revisionReason.length > 4000 || (history.events.some((e) => e.kind === "freeze") && !revisionReason)) throw new SandboxError(400, "A reason is required when revising a frozen plan (maximum 4,000 characters)");
  const datasets = await identities(projectId, plan.datasets);
  const dir = path.join(planDirectory(projectId, source), "previews");
  fs.mkdirSync(dir, { recursive: true });
  let live = 0;
  for (const file of fs.readdirSync(dir).filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const abs = path.join(dir, file);
    if (Date.now() - fs.statSync(abs).mtimeMs > PLAN_PREVIEW_TTL_MS * 2) fs.rmSync(abs, { force: true });
    else live++;
  }
  if (live >= 64) throw new SandboxError(429, "Too many pending plan previews; wait for old previews to expire");
  const preview: AnalysisPlanPreview = { id: randomUUID(), source, sourceDigest: planDigest(entry), expectedHead: history.head, plan, datasets, revisionReason, createdAt: Date.now(), expiresAt: Date.now() + PLAN_PREVIEW_TTL_MS };
  publish(path.join(dir, `${preview.id}.json`), preview);
  return preview;
}
function appendEvent(projectId: string, history: AnalysisPlanHistory, event: AnalysisPlanEvent): AnalysisPlanHistory {
  if (history.events.length >= MAX_PLAN_EVENTS) throw new SandboxError(413, "Analysis-plan history is full; start a new hypothesis rather than rewriting history");
  const file = path.join(planDirectory(projectId, history.source), `${String(event.sequence).padStart(6, "0")}.json`);
  try { publish(file, event); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SandboxError(409, "Plan history changed. Reload and review again."); throw error; }
  return { source: history.source, head: event.digest, events: [...history.events, event] };
}
export async function freezeAnalysisPlan(projectId: string, source: PlanSource, input: unknown): Promise<AnalysisPlanHistory> {
  const raw = input as { previewId?: unknown; acknowledgeLocalFreeze?: unknown; acknowledgeUnverified?: unknown } | null;
  if (raw?.acknowledgeLocalFreeze !== true) throw new SandboxError(400, "Explicit confirmation of a local-only freeze is required");
  if (typeof raw.previewId !== "string" || !/^[a-f0-9-]{36}$/.test(raw.previewId)) throw new SandboxError(400, "Invalid plan preview id");
  let history = readAnalysisPlans(projectId, source);
  // Lost HTTP responses can be retried safely, including after preview expiry.
  if (history.events.some((e) => e.kind === "freeze" && e.previewId === raw.previewId)) return history;
  let preview: AnalysisPlanPreview;
  try { preview = readJson(path.join(planDirectory(projectId, source), "previews", `${raw.previewId}.json`)) as AnalysisPlanPreview; }
  catch { throw new SandboxError(410, "Plan preview is unavailable; review a new preview"); }
  if (preview.id !== raw.previewId || planDigest(preview.source) !== planDigest(source) || preview.expiresAt < Date.now() || !Number.isFinite(preview.expiresAt) || !validIdentities(preview.datasets)) throw new SandboxError(410, "Plan preview expired or is invalid");
  if (planDigest(savedSource(projectId, source)) !== preview.sourceDigest) throw new SandboxError(409, "The source notebook entry changed; review a new plan preview");
  checkHead(history, preview.expectedHead);
  if (preview.datasets.some((d) => !d.sha256) && raw.acknowledgeUnverified !== true) throw new SandboxError(400, "Explicitly acknowledge the unverified dataset identities before freezing");
  const measured = await identities(projectId, normalizeAnalysisPlan(preview.plan).datasets);
  const comparable = (data: PlanDatasetIdentity[]) => data.map(({ capturedAt: _time, ...d }) => d);
  if (planDigest(comparable(measured)) !== planDigest(comparable(preview.datasets))) throw new SandboxError(409, "Dataset identities changed since preview; review a new preview");
  history = readAnalysisPlans(projectId, source);
  if (history.events.some((e) => e.kind === "freeze" && e.previewId === raw.previewId)) return history;
  checkHead(history, preview.expectedHead);
  const unsigned = {
    version: 1 as const, kind: "freeze" as const, id: randomUUID(), sequence: history.events.length + 1,
    previousDigest: history.head, source, actor: "user" as const, recordedAt: Date.now(),
    revision: history.events.filter((e) => e.kind === "freeze").length + 1, previewId: preview.id,
    plan: preview.plan, datasets: measured, sourceDigest: preview.sourceDigest, revisionReason: preview.revisionReason,
    acknowledgedUnverified: raw.acknowledgeUnverified === true,
  };
  return appendEvent(projectId, history, { ...unsigned, digest: planDigest(unsigned) });
}
function normalizeDeviation(input: unknown): PlanDeviationInput {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw.planId !== "string" || raw.planId.length > 100 || ![...Object.keys(PLAN_TEXT_FIELDS), "datasets", "intent", "priorExposure"].includes(String(raw.field))) throw new SandboxError(400, "Select a frozen plan and valid plan field");
  for (const key of ["actual", "reason"] as const) if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 4000) throw new SandboxError(400, `${key} is required (maximum 4,000 characters)`);
  if (!["before-results", "after-results", "unknown"].includes(String(raw.timing))) throw new SandboxError(400, "Specify when the deviation was decided");
  if (raw.corrects !== undefined && (typeof raw.corrects !== "string" || raw.corrects.length > 100)) throw new SandboxError(400, "Invalid correction reference");
  return { planId: raw.planId, field: raw.field as PlanDeviationInput["field"], actual: (raw.actual as string).trim(), reason: (raw.reason as string).trim(), timing: raw.timing as PlanDeviationInput["timing"], ...(raw.corrects ? { corrects: raw.corrects as string } : {}) };
}
export function recordPlanDeviation(projectId: string, source: PlanSource, input: unknown): AnalysisPlanHistory {
  savedSource(projectId, source);
  const history = readAnalysisPlans(projectId, source);
  const raw = input as { expectedHead?: unknown };
  checkHead(history, raw?.expectedHead);
  const deviation = normalizeDeviation(input);
  const plan = history.events.find((e): e is FrozenPlanEvent => e.kind === "freeze" && e.id === deviation.planId);
  if (!plan) throw new SandboxError(404, "Frozen plan not found in this hypothesis's history");
  if (deviation.corrects && !history.events.some((e) => e.kind === "deviation" && e.id === deviation.corrects && e.planId === plan.id && e.field === deviation.field)) throw new SandboxError(400, "A correction must reference a deviation for the same plan and field");
  const unsigned = { version: 1 as const, kind: "deviation" as const, id: randomUUID(), sequence: history.events.length + 1, previousDigest: history.head, source, actor: "user" as const, recordedAt: Date.now(), ...deviation, planned: planFieldValue(plan.plan, deviation.field) };
  return appendEvent(projectId, history, { ...unsigned, digest: planDigest(unsigned) });
}
