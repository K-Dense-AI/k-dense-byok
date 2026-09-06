/**
 * Provenance for what the USER does to the sandbox through the file API.
 *
 * Every lineage chain ends somewhere, and in practice it ends at a file the
 * scientist uploaded. Without a record of that upload the root of every chain
 * read "no recorded provenance" — indistinguishable from a file that appeared
 * by unknown means. The same gap made an editor save look like corruption: the
 * artifact turned "stale" with nothing in its history to explain why.
 *
 * So the sandbox routes record their own effects here: upload, editor save,
 * move, delete. These rows are written by the server as it performs the
 * operation, hashed at write time like the lead agent's steps, and carry
 * `role: "user"`. The model still has no way to author them.
 *
 * Everything here is async and streams its hashes: these run inside request
 * handlers, and a synchronous hash of a 1GB upload would stall SSE for every
 * open tab. Hashing of files about to be deleted is additionally capped by a
 * byte budget, so removing a directory of large datasets stays fast — the
 * remainder is recorded by size and mtime, marked unhashed.
 *
 * Steps live in a reserved pseudo-session (USER_SESSION_ID) so they join the
 * project-scoped lookup like any other session's log.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiRelative, isUserVisible, isWithin } from "../sandbox-fs.ts";
import {
  appendStep,
  identifyAsync,
  MAX_EDGES_PER_STEP,
  PROVENANCE_SCHEMA_VERSION,
  USER_SESSION_ID,
  type ArtifactRef,
  type FileIdentity,
  type ProvenanceStep,
} from "./store.ts";

export type UserAction = "upload" | "save" | "move" | "delete";

/** Total bytes hashed when recording a deletion. Past this, remaining files
 *  are recorded by size/mtime only. */
export const MAX_PRIOR_HASH_BYTES = 1024 * 1024 * 1024;

/** Snapshot of a file taken BEFORE a destructive operation, so a deletion or
 *  overwrite can still record what was there. */
export interface PriorIdentity {
  rel: string;
  identity: FileIdentity | null;
}

/** Stat + hash a user-visible sandbox file as it stands right now. Null when
 *  it is not inside the sandbox or not user-visible; `identity` is null when it
 *  does not exist (yet). */
export async function priorIdentity(
  sandboxRoot: string,
  abs: string,
  opts: { hash?: boolean } = {},
): Promise<PriorIdentity | null> {
  if (!isWithin(sandboxRoot, abs) || !isUserVisible(abs, sandboxRoot)) return null;
  return { rel: apiRelative(sandboxRoot, abs), identity: await identifyAsync(abs, opts) };
}

/** Every regular user-visible file under `abs` (itself, if a file), bounded so
 *  deleting a directory holding a reference genome does not walk all of it. */
export async function collectPrior(
  sandboxRoot: string,
  abs: string,
  opts: { hash: boolean; limit?: number; hashBudgetBytes?: number },
): Promise<PriorIdentity[]> {
  const limit = opts.limit ?? MAX_EDGES_PER_STEP + 1;
  let budget = opts.hashBudgetBytes ?? MAX_PRIOR_HASH_BYTES;
  const out: PriorIdentity[] = [];
  const queue = [abs];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.pop()!;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const hash = opts.hash && stat.size <= budget;
      const prior = await priorIdentity(sandboxRoot, current, { hash });
      if (prior) {
        if (hash) budget -= stat.size;
        out.push(prior);
      }
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(current);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      if (entry.startsWith(".")) continue;
      queue.push(path.join(current, entry));
    }
  }
  return out;
}

function refFromIdentity(
  rel: string,
  identity: FileIdentity,
  change: ArtifactRef["change"],
): ArtifactRef {
  return {
    path: rel,
    ...(identity.sha256 ? { sha256: identity.sha256 } : {}),
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    change,
    confidence: "observed",
    ...(identity.hashSkipped ? { hashSkipped: identity.hashSkipped } : {}),
  };
}

async function currentRef(
  sandboxRoot: string,
  abs: string,
  change: ArtifactRef["change"],
): Promise<ArtifactRef | null> {
  const now = await priorIdentity(sandboxRoot, abs);
  if (!now?.identity) return null;
  return refFromIdentity(now.rel, now.identity, change);
}

function deletedRef(prior: PriorIdentity, sha256?: string): ArtifactRef {
  const digest = sha256 ?? prior.identity?.sha256;
  return {
    path: prior.rel,
    ...(digest ? { sha256: digest } : {}),
    size: prior.identity?.size ?? 0,
    mtimeMs: prior.identity?.mtimeMs ?? 0,
    change: "deleted",
    confidence: "observed",
    ...(!digest && prior.identity?.hashSkipped ? { hashSkipped: prior.identity.hashSkipped } : {}),
  };
}

export interface UserStepInput {
  projectId: string;
  action: UserAction;
  args?: unknown;
  inputs?: ArtifactRef[];
  outputs: ArtifactRef[];
}

/** Append one user step. Never throws — a provenance failure must not turn a
 *  successful upload into a 500. Returns the step, or null on failure. */
export function recordUserStep(
  input: UserStepInput,
  onError?: (err: unknown) => void,
): ProvenanceStep | null {
  if (input.outputs.length === 0 && (input.inputs?.length ?? 0) === 0) return null;
  const step: ProvenanceStep = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `user:${crypto.randomUUID()}`,
    sessionId: USER_SESSION_ID,
    timestamp: Date.now(),
    toolName: input.action,
    ...(input.args !== undefined ? { args: input.args } : {}),
    role: "user",
    inputs: input.inputs ?? [],
    outputs: input.outputs,
  };
  try {
    appendStep(step, input.projectId);
    return step;
  } catch (err) {
    onError?.(err);
    return null;
  }
}

// --- one helper per route --------------------------------------------------

/** Files just landed by POST /sandbox/upload. Destinations are always fresh
 *  paths (the route never overwrites), so each is `created`. */
export async function recordUpload(
  projectId: string,
  sandboxRoot: string,
  absPaths: string[],
  onError?: (err: unknown) => void,
): Promise<ProvenanceStep | null> {
  try {
    const outputs: ArtifactRef[] = [];
    for (const abs of absPaths) {
      const ref = await currentRef(sandboxRoot, abs, "created");
      if (ref) outputs.push(ref);
    }
    return recordUserStep({ projectId, action: "upload", outputs }, onError);
  } catch (err) {
    onError?.(err);
    return null;
  }
}

/** PUT /sandbox/file. `before` is the pre-write identity (null when the path
 *  did not exist), which decides created-vs-modified and lets the record show
 *  what was overwritten as an input. */
export async function recordSave(
  projectId: string,
  sandboxRoot: string,
  abs: string,
  before: PriorIdentity | null,
  onError?: (err: unknown) => void,
): Promise<ProvenanceStep | null> {
  try {
    const existed = !!before?.identity;
    const ref = await currentRef(sandboxRoot, abs, existed ? "modified" : "created");
    if (!ref) return null;
    // The overwritten bytes are the input to an edit — recording them keeps the
    // previous version's hash reachable from the lineage.
    const inputs =
      before?.identity ? [refFromIdentity(before.rel, before.identity, "read")] : [];
    return recordUserStep({ projectId, action: "save", inputs, outputs: [ref] }, onError);
  } catch (err) {
    onError?.(err);
    return null;
  }
}

/** POST /sandbox/move. `priors` were collected under the SOURCE before the
 *  rename (stat-only is enough — a rename does not change bytes, so the input
 *  hash is taken from the destination); each maps to the same relative
 *  position under the destination. The source appears as an input so a lineage
 *  walk passes straight through the move, and as a deleted output so its old
 *  path is accounted for. Created refs come first so the per-step edge cap
 *  drops the deletions before the files that still exist. */
export async function recordMove(
  projectId: string,
  sandboxRoot: string,
  srcAbs: string,
  destAbs: string,
  priors: PriorIdentity[],
  onError?: (err: unknown) => void,
): Promise<ProvenanceStep | null> {
  try {
    const inputs: ArtifactRef[] = [];
    const created: ArtifactRef[] = [];
    const deleted: ArtifactRef[] = [];
    const srcRel = apiRelative(sandboxRoot, srcAbs);
    for (const prior of priors) {
      const suffix = prior.rel === srcRel ? "" : prior.rel.slice(srcRel.length);
      const destFile = path.join(destAbs, ...suffix.split("/").filter(Boolean));
      const moved = await currentRef(sandboxRoot, destFile, "created");
      if (!moved) continue;
      inputs.push({ ...moved, path: prior.rel, change: "read" });
      created.push(moved);
      deleted.push(deletedRef(prior, moved.sha256));
    }
    return recordUserStep(
      {
        projectId,
        action: "move",
        args: { src: srcRel, dest: apiRelative(sandboxRoot, destAbs) },
        inputs,
        outputs: [...created, ...deleted],
      },
      onError,
    );
  } catch (err) {
    onError?.(err);
    return null;
  }
}

/** DELETE /sandbox/file and /sandbox/directory, from identities collected
 *  before the removal. */
export async function recordDelete(
  projectId: string,
  priors: PriorIdentity[],
  onError?: (err: unknown) => void,
): Promise<ProvenanceStep | null> {
  return recordUserStep(
    { projectId, action: "delete", outputs: priors.map((prior) => deletedRef(prior)) },
    onError,
  );
}
