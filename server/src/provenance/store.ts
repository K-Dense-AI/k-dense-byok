/**
 * Durable per-session provenance store.
 *
 * One JSONL row per observed agent step under
 * sandbox/.kady/provenance/<sessionId>/steps.jsonl — the same layout family as
 * the cost ledger (.kady/runs/<sessionId>/costs.jsonl) and the lab notebook
 * (.kady/notebook/<sessionId>.jsonl).
 *
 * Design principle: rows here are DERIVED FROM OBSERVATION, never from model
 * declaration. The agent has no tool that writes to this store — the run loop
 * does, from Pi's event stream. Provenance is what you check the model against,
 * so a record the model could author would defeat its own purpose.
 *
 * Every artifact edge therefore carries a `confidence`. An edge we could only
 * infer is never presented as an observed fact; see recorder.ts for how each
 * tool class earns its level.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { activePaths, resolvePaths } from "../projects.ts";
import { isValidSessionId } from "../agent/notebook-store.ts";

export const PROVENANCE_SCHEMA_VERSION = 1 as const;

/** Above this, record size/mtime only — hashing a multi-GB matrix per step
 *  would dominate the run. Reported as `hashSkipped` so the gap is visible. */
export const MAX_HASH_BYTES = 512 * 1024 * 1024;

/** Tool args are stored for the methods record, not for replay. Cap them the
 *  way events.ts caps tool results. */
export const MAX_ARGS_BYTES = 4 * 1024;

/** A script that writes thousands of files gets truncated rather than bloating
 *  one row into megabytes. Surfaced as `truncatedEdges`. */
export const MAX_EDGES_PER_STEP = 200;

/** How much we trust an artifact edge. Never launder `inferred` into `observed`. */
export type EdgeConfidence =
  /** The tool named this path and we verified the bytes on disk. */
  | "observed"
  /** A scan attributed this change to the step, but attribution could be off. */
  | "inferred"
  /** The model asserted the link and nothing verified it. */
  | "declared";

export type ArtifactChange =
  | "created"
  | "modified"
  | "deleted"
  | "read"
  | "unchanged"
  /** Written, but created-vs-modified is unknown (no before-state was seen).
   *  Harvested subagent writes land here rather than guessing one or the other. */
  | "wrote";

/**
 * When the recorded size/hash was measured.
 *
 * `write` (the default, and the only value for lead-agent steps) means the file
 * was identified immediately after the producing call, so the hash is what that
 * step actually produced. `harvest` means it was identified later — when a
 * subagent's session file was parsed — so the bytes may already have changed
 * since the step wrote them. Staleness must never report "current" off a
 * harvest-time hash; see lookup.ts.
 */
export type IdentityTiming = "write" | "harvest";

export interface ArtifactRef {
  /** Sandbox-relative, wire format (forward slashes). */
  path: string;
  sha256?: string;
  size: number;
  mtimeMs: number;
  change: ArtifactChange;
  confidence: EdgeConfidence;
  /** Omitted means "write" — measured right after the producing call. */
  identityAt?: IdentityTiming;
  hashSkipped?: "too-large" | "unreadable";
}

/** Why a step's file attribution is less complete than the normal case. */
export type DegradeReason =
  /** The sandbox exceeded the scan budget; declared paths only. */
  | "sandbox-too-large"
  /** The scan itself failed (permissions, races); declared paths only. */
  | "scan-failed"
  /**
   * The step ran inside a subagent's child process and was reconstructed from
   * its session file afterward. No before/after sandbox snapshot exists for it,
   * so an opaque call like `bash` has no observable file effects at all — the
   * gap is recorded rather than being reported as "wrote nothing".
   */
  | "no-scan-baseline";

export interface ProvenanceStep {
  schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  /** Pi's toolCallId — stable, and the same id the notebook and SSE frames use. */
  id: string;
  sessionId: string;
  /** The POST /run invocation this step belongs to (see agent/run-ids.ts). */
  runId?: string;
  /** tool_execution_start / tool_execution_end wall-clock. */
  startedAt?: number;
  timestamp: number;
  toolName: string;
  /** Relativized + capped tool args. */
  args?: unknown;
  isError?: boolean;
  /** Canonical provider/model ref in effect for the step. */
  model?: string;
  role: "agent" | "subagent";
  /** Specialist name when role is "subagent". */
  agentName?: string;
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  degraded?: DegradeReason;
  truncatedEdges?: number;
}

export function provenanceSessionDir(sessionId: string, projectId?: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  // Matches notebook-store: an omitted projectId means "the request's project".
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.provenanceDir, sessionId);
}

export function stepsPath(sessionId: string, projectId?: string): string {
  return path.join(provenanceSessionDir(sessionId, projectId), "steps.jsonl");
}

/** sha256 of a file, streamed in chunks so a large artifact never lands in one
 *  buffer. Returns null when the file cannot be read (deleted mid-scan, EACCES). */
export function sha256File(absPath: string): string | null {
  try {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let read = 0;
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export interface FileIdentity {
  size: number;
  mtimeMs: number;
  sha256?: string;
  hashSkipped?: "too-large" | "unreadable";
}

/** Stat + (bounded) hash one existing file. Null when it is not a regular file. */
export function identify(absPath: string): FileIdentity | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const base = { size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.size > MAX_HASH_BYTES) {
    return { ...base, hashSkipped: "too-large" };
  }
  const digest = sha256File(absPath);
  return digest === null ? { ...base, hashSkipped: "unreadable" } : { ...base, sha256: digest };
}

function cappedArgs(args: unknown): unknown {
  if (args === undefined || args === null) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (encoded === undefined) return undefined;
  if (Buffer.byteLength(encoded, "utf-8") <= MAX_ARGS_BYTES) return args;
  return { truncated: true, preview: encoded.slice(0, MAX_ARGS_BYTES) };
}

/** Enforce the per-step edge cap and arg cap, reporting what was dropped. */
export function boundStep(step: ProvenanceStep): ProvenanceStep {
  const total = step.inputs.length + step.outputs.length;
  if (total <= MAX_EDGES_PER_STEP) {
    return { ...step, args: cappedArgs(step.args) };
  }
  // Outputs are the point of a provenance record; keep them ahead of inputs.
  const outputs = step.outputs.slice(0, MAX_EDGES_PER_STEP);
  const inputs = step.inputs.slice(0, Math.max(0, MAX_EDGES_PER_STEP - outputs.length));
  return {
    ...step,
    args: cappedArgs(step.args),
    inputs,
    outputs,
    truncatedEdges: total - (inputs.length + outputs.length),
  };
}

export function appendStep(step: ProvenanceStep, projectId?: string): void {
  const file = stepsPath(step.sessionId, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(boundStep(step)) + "\n", "utf-8");
}

/**
 * Append only steps whose ids are not already in the session's log.
 *
 * Subagent harvest re-reads a child's whole session file on every completion and
 * relies on stable namespaced step ids, so an in-memory guard alone loses its
 * state on restart and re-appends the child's entire history. The log on disk is
 * the durable record of what has already been harvested — the same reasoning as
 * appendNewNotebookEntries.
 *
 * Returns the steps actually written.
 */
export function appendNewSteps(
  sessionId: string,
  steps: ProvenanceStep[],
  projectId?: string,
): ProvenanceStep[] {
  if (steps.length === 0) return [];
  const file = stepsPath(sessionId, projectId);
  const seen = new Set(parseStepsFile(file).map((step) => step.id));
  const fresh: ProvenanceStep[] = [];
  for (const step of steps) {
    if (!step.id || seen.has(step.id)) continue;
    seen.add(step.id);
    fresh.push(step);
  }
  if (fresh.length === 0) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    fresh.map((step) => JSON.stringify(boundStep(step)) + "\n").join(""),
    "utf-8",
  );
  return fresh;
}

function parseStepsFile(file: string): ProvenanceStep[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw exc;
  }
  const out: ProvenanceStep[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ProvenanceStep;
      // Forward-compat: ignore rows written by a newer schema rather than
      // surfacing fields this build does not understand.
      if (parsed.schemaVersion !== PROVENANCE_SCHEMA_VERSION) continue;
      out.push(parsed);
    } catch {
      // Skip a truncated/corrupt row rather than failing the whole read.
    }
  }
  return out;
}

export function readSteps(sessionId: string, projectId?: string): ProvenanceStep[] {
  return parseStepsFile(stepsPath(sessionId, projectId));
}

/** Every session's steps in a project. A figure opened in one tab may have been
 *  produced by another, so artifact lookups are project-scoped. */
export function readProjectSteps(projectId: string): ProvenanceStep[] {
  const dir = resolvePaths(projectId).provenanceDir;
  let sessions: string[];
  try {
    sessions = fs.readdirSync(dir);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw exc;
  }
  const out: ProvenanceStep[] = [];
  for (const sessionId of sessions.sort()) {
    if (!isValidSessionId(sessionId)) continue;
    out.push(...parseStepsFile(path.join(dir, sessionId, "steps.jsonl")));
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
