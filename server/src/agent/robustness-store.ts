/** Immutable robustness previews and bounded, private input snapshots. */
import fs, { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePaths } from "../projects.ts";
import { isWithin, isUserVisible } from "../sandbox-fs.ts";
import { normalizeTransferPath } from "../modal/transfer.ts";
import { managedPath, ROBUSTNESS_ID_RE, publishExclusiveJson, readManagedJson } from "../modal/approved.ts";
import { ModalJobError } from "../modal/types.ts";
import { jsonDigest } from "../canonical-json.ts";
import { normalizeRobustnessDraft, type RobustnessPreview, type RobustnessFile } from "../../../web/src/lib/notebook-robustness.ts";

export const ROBUSTNESS_TTL_MS = 15 * 60_000;
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_PROJECT_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
export const MAX_ROBUSTNESS_WORKFLOWS = 100;
export const ROBUSTNESS_OUTPUT_ROOT = "robustness-results";
export const ROBUSTNESS_CONFIG_ROOT = "__kady_robustness";
export { publishExclusiveJson, readManagedJson };
export function robustnessRoot(projectId: string): string { return managedPath(projectId, ".kady/notebook/robustness"); }
export function robustnessDir(projectId: string, id: string): string {
  if (!ROBUSTNESS_ID_RE.test(id)) throw new ModalJobError("INVALID_WORKFLOW", "Invalid robustness workflow id");
  return managedPath(projectId, `.kady/notebook/robustness/${id}`);
}
export function listRobustnessIds(projectId: string): string[] {
  try {
    const ids = fs.readdirSync(robustnessRoot(projectId)).filter((s) => ROBUSTNESS_ID_RE.test(s)).sort();
    if (ids.length > MAX_ROBUSTNESS_WORKFLOWS) throw new ModalJobError("WORKFLOW_LIMIT", "Robustness history exceeds its bounded workflow limit", 413);
    return ids;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
export function readRobustnessPreview(projectId: string, id: string): RobustnessPreview {
  const value = readManagedJson<RobustnessPreview>(path.join(robustnessDir(projectId, id), "preview.json"));
  const { digest, ...payload } = value;
  if (value.version !== 1 || value.projectId !== projectId || value.id !== id || jsonDigest(payload) !== digest || !Array.isArray(value.jobs) || value.jobs.length < 2 || value.jobs.length > 16) throw new ModalJobError("INVALID_RECORD", "Robustness preview is inconsistent; it was not reset", 503);
  normalizeRobustnessDraft(value.draft);
  return value;
}
export function sourcePath(projectId: string, raw: string): { rel: string; abs: string } {
  const rel = normalizeTransferPath(raw);
  const sandbox = resolvePaths(projectId).sandbox;
  const abs = path.resolve(sandbox, rel);
  if (!isWithin(sandbox, abs) || !isUserVisible(abs, sandbox) || rel.startsWith(`${ROBUSTNESS_CONFIG_ROOT}/`) || rel.startsWith(`${ROBUSTNESS_OUTPUT_ROOT}/`) || /[*?]/.test(rel)) throw new ModalJobError("UNSAFE_INPUT", "Use explicit visible input files outside workflow output/control directories", 403);
  const real = fs.realpathSync(abs);
  if (!isWithin(fs.realpathSync(sandbox), real) || !isUserVisible(real, fs.realpathSync(sandbox))) throw new ModalJobError("UNSAFE_INPUT", "Input symlink leaves the visible sandbox", 403);
  return { rel, abs: real };
}
/** One async streaming pass: copy the exact bytes being hashed, detect races,
 * and never follow a growing file past its initial size or accept a FIFO. */
export async function snapshotInputs(projectId: string, inputs: string[], destination?: string): Promise<RobustnessFile[]> {
  const unique = [...new Set(inputs)].sort();
  if (unique.length > 33) throw new ModalJobError("INPUT_LIMIT", "At most 32 input files plus the script are supported", 413);
  let total = 0;
  const files: RobustnessFile[] = [];
  for (const raw of unique) {
    const { rel, abs } = sourcePath(projectId, raw);
    if (!(await fs.promises.stat(abs)).isFile()) throw new ModalJobError("INVALID_INPUT", `Input must be a regular file: ${rel}`);
    const file = await fs.promises.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let output: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_SNAPSHOT_FILE_BYTES || total + before.size > MAX_SNAPSHOT_BYTES) throw new ModalJobError("INPUT_LIMIT", "Snapshot exceeds 128 MiB/file or 256 MiB total", 413);
      total += before.size;
      if (destination) {
        const dest = path.resolve(destination, rel);
        if (!isWithin(destination, dest)) throw new ModalJobError("UNSAFE_INPUT", "Snapshot path escaped", 403);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        output = await fs.promises.open(dest, "wx", 0o600);
      }
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new ModalJobError("INPUT_CHANGED", `Input changed during snapshot: ${rel}`, 409);
        hash.update(buffer.subarray(0, bytesRead));
        if (output) {
          let written = 0;
          while (written < bytesRead) {
            const n = (await output.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
            if (!n) throw new Error("Snapshot write made no progress");
            written += n;
          }
        }
        position += bytesRead;
      }
      const after = await file.stat(); const now = await fs.promises.stat(abs);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== now.ino || after.size !== now.size || after.mtimeMs !== now.mtimeMs || after.ctimeMs !== now.ctimeMs) throw new ModalJobError("INPUT_CHANGED", `Input changed during snapshot: ${rel}`, 409);
      await output?.sync();
      files.push({ path: rel, size: before.size, sha256: hash.digest("hex") });
    } finally { await output?.close(); await file.close(); }
  }
  return files;
}
/** Clean only unapproved expired previews. Approved evidence is never removed. */
export function checkSnapshotQuota(projectId: string, newBytes: number, excludeId?: string): void {
  let bytes = 0; let count = 0;
  for (const id of listRobustnessIds(projectId)) {
    if (id === excludeId) continue;
    const dir = robustnessDir(projectId, id);
    const approved = fs.existsSync(path.join(dir, "approval.json"));
    const file = path.join(dir, "preview.json");
    if (!approved && Date.now() - fs.statSync(dir).mtimeMs > ROBUSTNESS_TTL_MS * 2) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    count++;
    if (fs.existsSync(file)) bytes += readRobustnessPreview(projectId, id).inputFiles.reduce((n, f) => n + f.size, 0);
    else bytes += MAX_SNAPSHOT_BYTES; // interrupted preparation: conservatively retain its quota
  }
  if (count >= MAX_ROBUSTNESS_WORKFLOWS || bytes + newBytes > MAX_PROJECT_SNAPSHOT_BYTES) throw new ModalJobError("SNAPSHOT_QUOTA", "Retained robustness snapshots reached the project limit (100 workflows / 1 GiB). Archive or use a new project; approved evidence is not auto-deleted.", 413);
}
