/**
 * Citation-time identities and read-time freshness. These are server measured,
 * never model supplied. Not a scientific verdict or a reproducible snapshot:
 * only hashes are retained, not historical bytes. IO is async and bounded.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePaths } from "../projects.ts";
import { apiRelative, isUserVisible, isWithin } from "../sandbox-fs.ts";
import type { NotebookEntry } from "./notebook-store.ts";
import type { NotebookArtifactSnapshot, NotebookArtifactHealth } from "../../../web/src/lib/notebook-evidence-core.ts";

export const NOTEBOOK_ARTIFACT_LIMIT = 25;
export const NOTEBOOK_HASH_FILE_BYTES = 8 * 1024 * 1024;
export const NOTEBOOK_HASH_TOTAL_BYTES = 32 * 1024 * 1024;
export const NOTEBOOK_CHECK_FILES = 100;
type Check = Omit<NotebookArtifactSnapshot, "timing">;
interface Budget { bytes: number; files: number }

async function checkArtifact(sandbox: string, requested: string, budget: Budget): Promise<Check> {
  const base: Check = { path: requested, capturedAt: Date.now() };
  if (--budget.files < 0) return { ...base, reason: "budget" };
  const abs = path.resolve(sandbox, requested);
  if (!isWithin(sandbox, abs) || !isUserVisible(abs, sandbox) || requested.includes("\0")) return { ...base, reason: "unsafe-path" };
  base.path = apiRelative(sandbox, abs);
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const [root, real] = await Promise.all([fs.realpath(sandbox), fs.realpath(abs)]);
    if (!isWithin(root, real) || !isUserVisible(real, root)) return { ...base, reason: "unsafe-path" };
    // Reject devices/FIFOs before opening; O_NONBLOCK prevents a racing FIFO
    // replacement from hanging a notebook request. O_NOFOLLOW rejects a final
    // symlink swapped in after realpath (where the platform supports it).
    if (!(await fs.stat(real)).isFile()) return { ...base, reason: "unreadable" };
    file = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const before = await file.stat();
    if (!before.isFile()) return { ...base, reason: "unreadable" };
    base.size = before.size;
    if (before.size > NOTEBOOK_HASH_FILE_BYTES || before.size > budget.bytes) return { ...base, reason: "budget" };
    budget.bytes -= before.size;
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)));
    let position = 0;
    // Never chase a concurrently growing file beyond its initial size.
    while (position < before.size) {
      const { bytesRead } = await file.read(buf, 0, Math.min(buf.length, before.size - position), position);
      if (bytesRead === 0) return { ...base, reason: "changed-during-check" };
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    const current = await fs.stat(abs);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== current.ino || after.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) return { ...base, reason: "changed-during-check" };
    return { ...base, capturedAt: Date.now(), sha256: hash.digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...base, reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function captureNotebookArtifacts(projectId: string, artifacts: string[]): Promise<NotebookArtifactSnapshot[]> {
  const budget = { files: NOTEBOOK_ARTIFACT_LIMIT, bytes: NOTEBOOK_HASH_TOTAL_BYTES };
  const out: NotebookArtifactSnapshot[] = [];
  for (const artifact of [...new Set(artifacts)].slice(0, NOTEBOOK_ARTIFACT_LIMIT)) {
    out.push({ ...await checkArtifact(resolvePaths(projectId).sandbox, artifact, budget), timing: "entry" });
  }
  return out;
}

/** Pure comparison. Missing hashes and harvest-time identities never earn unchanged. */
export function compareNotebookArtifact(recorded: NotebookArtifactSnapshot | undefined, current: Check): NotebookArtifactHealth {
  const base = { path: current.path, checkedAt: current.capturedAt };
  if (current.reason === "missing") return { ...base, status: "missing", reason: "Cited artifact is missing. Review this entry; this does not refute its claim." };
  if (current.reason) return { ...base, status: "unverified", reason: `Artifact check incomplete: ${current.reason}.` };
  if (recorded?.sha256 && current.sha256) {
    if (recorded.sha256 !== current.sha256) return { ...base, status: "changed", reason: recorded.timing === "harvest" ? "Bytes changed since a later identity check; original citation-time bytes are unknown." : recorded.timing === "output" ? "Bytes differ from the server-recorded compute output. Review against the retained result." : "Bytes differ from the recorded citation. Review the interpretation against the new artifact." };
    if (recorded.timing === "entry" || recorded.timing === "output") return { ...base, status: "unchanged", reason: recorded.timing === "output" ? "Bytes match the server-recorded compute output. This does not verify scientific validity or unchanged upstream inputs." : "Bytes match the citation-time hash. This does not verify scientific validity or unchanged upstream inputs." };
  }
  return { ...base, status: "unverified", reason: recorded?.timing === "harvest" ? "Identity was captured later, not when the entry was written." : "No citation-time hash was recorded. Historical bytes cannot be verified." };
}

/** Shared across GET and exports. Recent entries get the bounded IO budget first. */
export async function withNotebookArtifactHealth<T extends NotebookEntry>(entries: T[], projectId: string): Promise<T[]> {
  const sandbox = resolvePaths(projectId).sandbox;
  const budget = { files: NOTEBOOK_CHECK_FILES, bytes: NOTEBOOK_HASH_TOTAL_BYTES };
  const checks = new Map<string, Check>();
  const result = new Map<T, T>();
  for (const entry of [...entries].sort((a, b) => b.timestamp - a.timestamp)) {
    // Derived metadata in a hand-edited JSONL is never trusted as a cached verdict.
    const { artifactHealth: _old, artifactHealthTruncated: _truncated, ...rest } = entry;
    const artifacts = Array.isArray(entry.artifacts) ? [...new Set(entry.artifacts.filter((a) => typeof a === "string"))] : [];
    if (!artifacts.length) { result.set(entry, rest as T); continue; }
    const health: NotebookArtifactHealth[] = [];
    for (const artifact of artifacts.slice(0, NOTEBOOK_ARTIFACT_LIMIT)) {
      // Check cache is request-local only: never use stat equality as hash proof.
      let check = checks.get(artifact);
      if (!check) { check = await checkArtifact(sandbox, artifact, budget); checks.set(artifact, check); }
      const snapshots = Array.isArray(entry.artifactSnapshots) ? entry.artifactSnapshots : [];
      const recorded = snapshots.find((s) => s && s.path === check!.path);
      health.push(compareNotebookArtifact(recorded, check));
    }
    result.set(entry, {
      ...rest, artifactHealth: health,
      ...(artifacts.length > NOTEBOOK_ARTIFACT_LIMIT ? { artifactHealthTruncated: artifacts.length - NOTEBOOK_ARTIFACT_LIMIT } : {}),
    } as T);
  }
  return entries.map((entry) => result.get(entry)!);
}
