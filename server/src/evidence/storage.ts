/** Bounded local snapshot/package storage. Never executes captured code. */
import fs, { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { resolvePaths } from "../projects.ts";
import { apiRelative, isUserVisible, isWithin } from "../sandbox-fs.ts";
import { managedPath, publishExclusiveJson, readManagedJson } from "../modal/approved.ts";
import { jsonDigest } from "../canonical-json.ts";
import type { EvidencePackagePreview, EvidenceStorage } from "../../../web/src/lib/evidence-packages.ts";

export const PACKAGE_ID = /^ep_[a-f0-9]{32}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const PACKAGE_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_BYTES = 128 * 1024 * 1024;
export const SNAPSHOT_QUOTA = 1024 * 1024 * 1024;
export const PACKAGE_QUOTA = 2 * 1024 * 1024 * 1024;
export const PACKAGE_COUNT = 20;
export const ZIP_BYTES = PACKAGE_BYTES + 8 * 1024 * 1024;
export class EvidencePackageError extends Error {
  statusCode: number; code: string;
  constructor(code: string, message: string, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
const locks = new Map<string, Promise<unknown>>();
export async function evidenceExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(projectId) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(projectId, next);
  try { return await next; } finally { if (locks.get(projectId) === next) locks.delete(projectId); }
}
export function evidenceRoot(projectId: string): string { return managedPath(projectId, ".kady/evidence"); }
export function packageDirectory(projectId: string, id: string): string {
  if (!PACKAGE_ID.test(id)) throw new EvidencePackageError("INVALID_PACKAGE", "Invalid evidence package id");
  return managedPath(projectId, `.kady/evidence/packages/${id}`);
}
export function blobPath(projectId: string, sha: string): string {
  if (!SHA256.test(sha)) throw new EvidencePackageError("INVALID_HASH", "Invalid snapshot hash");
  return managedPath(projectId, `.kady/evidence/blobs/${sha}`);
}
export function artifactPath(projectId: string, raw: string, lockfile = false): { path: string; absolute: string } {
  if (typeof raw !== "string" || !raw || raw.includes("\0") || /^(?:[A-Za-z]:|\\\\)/.test(raw)) throw new EvidencePackageError("UNSAFE_PATH", "Artifact path is not a portable sandbox path", 403);
  const root = resolvePaths(projectId).sandbox;
  const absolute = path.resolve(root, raw);
  const rel = apiRelative(root, absolute);
  const allowedLock = lockfile && ["uv.lock", "pyproject.toml", "requirements.txt", "requirements-dev.txt", "environment.yml", "environment.yaml", "renv.lock", "DESCRIPTION", "Project.toml", "Manifest.toml"].includes(rel);
  if (!isWithin(root, absolute) || absolute === root || (!allowedLock && !isUserVisible(absolute, root)) || /^(auth|credentials|secrets)\.json$/i.test(path.basename(absolute))) throw new EvidencePackageError("UNSAFE_PATH", "Private/credential paths and sandbox escapes are not packaged", 403);
  return { path: rel, absolute };
}
async function openSafe(projectId: string, absolute: string, visible: boolean, lockfile = false) {
  const root = resolvePaths(projectId).sandbox;
  if (!isWithin(root, absolute)) throw new EvidencePackageError("UNSAFE_PATH", "Source leaves the project", 403);
  if (lockfile && (await fs.promises.lstat(absolute)).isSymbolicLink()) throw new EvidencePackageError("UNSAFE_PATH", "Recorded lockfiles must not be symlinks", 403);
  const [realRoot, real] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(absolute)]);
  if (!isWithin(realRoot, real) || (visible && !lockfile && !isUserVisible(real, realRoot)) || (visible && /^(auth|credentials|secrets)\.json$/i.test(path.basename(real)))) throw new EvidencePackageError("UNSAFE_PATH", "Source symlink leaves the permitted project data", 403);
  if (!(await fs.promises.stat(real)).isFile()) throw new EvidencePackageError("NOT_FILE", "Only regular files can be packaged");
  const handle = await fs.promises.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const stat = await handle.stat();
  if (!stat.isFile()) { await handle.close(); throw new EvidencePackageError("NOT_FILE", "Source changed to a non-file"); }
  return { handle, stat };
}
export interface ReadBudget { remaining: number }
/** Reads exactly the bounded original byte range and detects observed changes. */
export async function readEvidenceBytes(projectId: string, absolute: string, limit: number, budget?: ReadBudget): Promise<Buffer> {
  const { handle, stat } = await openSafe(projectId, absolute, false);
  try {
    if (stat.size > limit || budget && stat.size > budget.remaining) throw new EvidencePackageError("READ_BUDGET", "Source exceeds the evidence read budget", 413);
    if (budget) budget.remaining -= stat.size;
    const data = Buffer.alloc(stat.size); let position = 0;
    while (position < data.length) {
      const n = (await handle.read(data, position, data.length - position, position)).bytesRead;
      if (!n) throw new EvidencePackageError("SOURCE_CHANGED", "Source changed while reading", 409);
      position += n;
    }
    const after = await handle.stat(); const current = await fs.promises.stat(absolute);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || after.ino !== current.ino || after.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw new EvidencePackageError("SOURCE_CHANGED", "Source changed while reading", 409);
    return data;
  } finally { await handle.close(); }
}
export async function hashEvidenceFile(projectId: string, absolute: string, limit: number, budget?: ReadBudget): Promise<{ sha256: string; size: number }> {
  const { handle, stat } = await openSafe(projectId, absolute, false);
  try {
    if (stat.size > limit || budget && stat.size > budget.remaining) throw new EvidencePackageError("READ_BUDGET", "File exceeds the evidence verification budget", 413);
    if (budget) budget.remaining -= stat.size;
    const hash = crypto.createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < stat.size) {
      const n = (await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)).bytesRead;
      if (!n) throw new EvidencePackageError("SOURCE_CHANGED", "File changed during verification", 409);
      hash.update(buffer.subarray(0, n)); offset += n;
    }
    const after = await handle.stat(); const current = await fs.promises.stat(absolute);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new EvidencePackageError("SOURCE_CHANGED", "File changed during verification", 409);
    return { sha256: hash.digest("hex"), size: stat.size };
  } finally { await handle.close(); }
}
export function verifiedEvidenceStream(projectId: string, absolute: string, expected: { sha256: string; size: number }, limit = PACKAGE_BYTES): Readable {
  return Readable.from((async function* () {
    const { handle, stat } = await openSafe(projectId, absolute, false);
    try {
      if (stat.size !== expected.size || stat.size > limit) throw new EvidencePackageError("SNAPSHOT_CHANGED", "Packaged file size no longer matches the reviewed snapshot", 409);
      const hash = crypto.createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
      while (offset < stat.size) {
        const n = (await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)).bytesRead;
        if (!n) throw new EvidencePackageError("SNAPSHOT_CHANGED", "Packaged file changed during streaming", 409);
        const chunk = Buffer.from(buffer.subarray(0, n)); hash.update(chunk); offset += n; yield chunk;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || hash.digest("hex") !== expected.sha256) throw new EvidencePackageError("SNAPSHOT_CHANGED", "Packaged bytes no longer match their recorded checksum", 409);
    } finally { await handle.close(); }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}
export function bytesHash(bytes: Buffer | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
export interface CapturedBlob { sha256: string; size: number; absolute: string; created: boolean }
/** Stream/hash/copy in one pass, then publish content-addressed bytes exclusively. */
export async function captureBlob(projectId: string, absolute: string, expected: string | undefined, visible: boolean, budget: ReadBudget, lockfile = false): Promise<CapturedBlob> {
  const { handle, stat } = await openSafe(projectId, absolute, visible, lockfile);
  const root = managedPath(projectId, ".kady/evidence/blobs");
  await fs.promises.mkdir(root, { recursive: true });
  const tmp = path.join(root, `${crypto.randomUUID()}.tmp`);
  let output: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    if (stat.size > ARTIFACT_BYTES || stat.size > budget.remaining) throw new EvidencePackageError("ARTIFACT_BUDGET", "Artifact exceeds 128 MiB/file or the package read budget", 413);
    budget.remaining -= stat.size;
    output = await fs.promises.open(tmp, "wx", 0o600);
    const hash = crypto.createHash("sha256"); const buf = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < stat.size) {
      const n = (await handle.read(buf, 0, Math.min(buf.length, stat.size - position), position)).bytesRead;
      if (!n) throw new EvidencePackageError("SOURCE_CHANGED", "Artifact changed during capture", 409);
      hash.update(buf.subarray(0, n));
      let written = 0;
      while (written < n) {
        const size = (await output.write(buf, written, n - written, position + written)).bytesWritten;
        if (!size) throw new Error("Snapshot write made no progress");
        written += size;
      }
      position += n;
    }
    const after = await handle.stat(); const current = await fs.promises.stat(absolute);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || after.ino !== current.ino || after.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw new EvidencePackageError("SOURCE_CHANGED", "Artifact changed during capture", 409);
    const sha256 = hash.digest("hex");
    if (expected && sha256 !== expected) throw new EvidencePackageError("VERSION_MISMATCH", "Available bytes do not match the requested historical identity", 409);
    await output.sync(); await output.close(); output = undefined;
    const final = blobPath(projectId, sha256);
    let created = false;
    if (fs.existsSync(final)) {
      if ((await hashEvidenceFile(projectId, final, ARTIFACT_BYTES, budget)).sha256 !== sha256) throw new EvidencePackageError("CORRUPT_SNAPSHOT", "Retained snapshot is corrupt; it was not silently replaced", 409);
    } else {
      const used = snapshotBytes(projectId);
      if (used + stat.size > SNAPSHOT_QUOTA) throw new EvidencePackageError("SNAPSHOT_QUOTA", "Evidence snapshots reached their 1 GiB project quota; review/prune unreferenced snapshots", 413);
      await fs.promises.link(tmp, final); created = true;
    }
    return { sha256, size: stat.size, absolute: final, created };
  } finally { await output?.close(); await handle.close(); await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
}
function snapshotBytes(projectId: string): number {
  const root = managedPath(projectId, ".kady/evidence/blobs");
  if (!fs.existsSync(root)) return 0;
  const names = fs.readdirSync(root); if (names.length > 10000) throw new EvidencePackageError("STORAGE_LIMIT", "Snapshot directory exceeds its entry limit", 413);
  return names.filter((name) => SHA256.test(name)).reduce((total, name) => {
    const stat = fs.lstatSync(path.join(root, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new EvidencePackageError("UNSAFE_STORAGE", "Snapshot storage contains unsafe entries", 503);
    return total + stat.size;
  }, 0);
}
export function packageIds(projectId: string): string[] {
  const root = managedPath(projectId, ".kady/evidence/packages");
  if (!fs.existsSync(root)) return [];
  const names = fs.readdirSync(root).filter((name) => PACKAGE_ID.test(name));
  if (names.length > PACKAGE_COUNT) throw new EvidencePackageError("STORAGE_LIMIT", "Package directory exceeds its limit", 413);
  return names;
}
export function readPackage(projectId: string, id: string): EvidencePackagePreview {
  const p = readManagedJson<EvidencePackagePreview>(path.join(packageDirectory(projectId, id), "preview.json"), 2 * 1024 * 1024);
  const { digest, ...unsigned } = p;
  if (p.projectId !== projectId || p.id !== id || p.manifest?.projectId !== projectId || p.manifest.id !== id || jsonDigest(unsigned) !== digest || !SHA256.test(p.zipSha256) || !Number.isFinite(p.zipBytes) || p.zipBytes > ZIP_BYTES) throw new EvidencePackageError("INVALID_PACKAGE", "Package preview is inconsistent; it was not rebuilt or reset", 503);
  return p;
}
export function evidenceStorage(projectId: string): EvidenceStorage {
  let used = 0; const ids = packageIds(projectId);
  for (const id of ids) {
    const dir = packageDirectory(projectId, id);
    if (!fs.existsSync(path.join(dir, "preview.json"))) { used += PACKAGE_BYTES; continue; }
    const p = readPackage(projectId, id);
    used += p.zipBytes + p.files.filter((f) => !f.path.startsWith("artifacts/")).reduce((n, f) => n + f.size, 0);
  }
  return { snapshotsBytes: snapshotBytes(projectId), packagesBytes: used, snapshotsLimitBytes: SNAPSHOT_QUOTA, packagesLimitBytes: PACKAGE_QUOTA, packageCount: ids.length, packageLimit: PACKAGE_COUNT };
}
export { publishExclusiveJson };
