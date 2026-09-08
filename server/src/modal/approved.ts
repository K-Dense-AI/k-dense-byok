/** Server-owned batch admission gates and immutable-input checks. No model surface. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import { jsonDigest } from "../canonical-json.ts";
import { identifyAsync } from "../provenance/store.ts";
import { normalizeTransferPath, type LocalInputPlan } from "./transfer.ts";
import { ModalJobError, type ModalJob } from "./types.ts";
export const ROBUSTNESS_ID_RE = /^rw_[a-f0-9]{32}$/;

export function managedPath(projectId: string, rel: string): string {
  const sandbox = resolvePaths(projectId).sandbox;
  const target = path.resolve(sandbox, rel);
  if (!isWithin(sandbox, target)) throw new ModalJobError("UNSAFE_MANAGED_PATH", "Managed path leaves the sandbox", 403);
  if (fs.existsSync(sandbox)) {
    let ancestor = target;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (!isWithin(fs.realpathSync(sandbox), fs.realpathSync(ancestor))) throw new ModalJobError("UNSAFE_MANAGED_PATH", "Managed path symlink leaves the project", 403);
  }
  return target;
}
export function approvedBatchDir(projectId: string, id: string): string {
  if (!ROBUSTNESS_ID_RE.test(id)) throw new ModalJobError("INVALID_APPROVAL_ID", "Invalid approved batch id");
  return managedPath(projectId, `.kady/modal/approved-batches/${id}`);
}
export function approvedInputRoot(projectId: string, id: string): string {
  if (!ROBUSTNESS_ID_RE.test(id)) throw new ModalJobError("INVALID_APPROVAL_ID", "Invalid approved batch id");
  return managedPath(projectId, `.kady/notebook/robustness/${id}/inputs`);
}
export function publishExclusiveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(tmp, file);
    let dir: number | undefined;
    try { dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); } catch { /* Windows */ }
    finally { if (dir !== undefined) fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup, not a failed commit */ }
  }
}
export function readManagedJson<T>(file: string, maxBytes = 512 * 1024): T {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new ModalJobError("INVALID_RECORD", "Managed record is oversized or unsafe", 503);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
export function approvedJobDigest(job: Pick<ModalJob, "id" | "projectId" | "request" | "owner" | "approval">): string {
  return jsonDigest({ id: job.id, projectId: job.projectId, request: job.request, owner: job.owner, approval: job.approval });
}
export function batchCancelled(projectId: string, batchId: string): boolean {
  return fs.existsSync(path.join(approvedBatchDir(projectId, batchId), "cancelled.json"));
}
export function batchCommitted(projectId: string, batchId: string): boolean {
  return fs.existsSync(path.join(approvedBatchDir(projectId, batchId), "committed.json"));
}
export function assertApprovedJob(job: ModalJob, allowCancelled = false): void {
  if (!job.approval) return;
  if (!allowCancelled && batchCancelled(job.projectId, job.approval.batchId)) throw new ModalJobError("CANCELLED", "Approved workflow was cancelled", 409);
  let gate: { jobs: Record<string, string> };
  try { gate = readManagedJson(path.join(approvedBatchDir(job.projectId, job.approval.batchId), "committed.json")); }
  catch { throw new ModalJobError("APPROVAL_NOT_ADMITTED", "Approved batch is not fully admitted; no remote work may start", 409); }
  if (gate.jobs?.[job.id] !== approvedJobDigest(job)) throw new ModalJobError("APPROVAL_CHANGED", "Job no longer matches its approved batch", 409);
}
export async function approvedInputPlan(job: ModalJob, verified = new Set<string>()): Promise<LocalInputPlan> {
  const approval = job.approval!;
  const root = approvedInputRoot(job.projectId, approval.batchId);
  const localByPath = new Map<string, string>();
  if (!Array.isArray(approval.inputs) || approval.inputs.length > 34) throw new ModalJobError("INVALID_APPROVAL", "Invalid approved input manifest");
  for (const file of approval.inputs) {
    const rel = normalizeTransferPath(file.path);
    const local = path.resolve(root, rel);
    if (!isWithin(root, local) || !isWithin(fs.realpathSync(root), fs.realpathSync(local))) throw new ModalJobError("INPUT_CHANGED", "Approved input escaped its snapshot", 409);
    const key = `${local}:${file.sha256}:${file.size}`;
    if (!verified.has(key)) {
      const identity = await identifyAsync(local);
      if (!identity?.sha256 || identity.sha256 !== file.sha256 || identity.size !== file.size) throw new ModalJobError("INPUT_CHANGED", `Approved snapshot changed: ${rel}`, 409);
      verified.add(key);
    }
    localByPath.set(rel, local);
  }
  return { manifest: approval.inputs, localByPath };
}
