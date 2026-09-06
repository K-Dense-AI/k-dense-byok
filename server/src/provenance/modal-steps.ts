/**
 * Provenance for durable Modal compute jobs.
 *
 * A remote job is the one kind of step whose file effects the transfer layer
 * already measures exactly: `stageInputs` hashes every input as it uploads it
 * and `collectOutputs` hashes every output as it installs it. Those hashes were
 * taken at the moment the bytes crossed the boundary, so unlike a harvested
 * subagent step they need no "hashed later" caveat — they are `observed`, at
 * write time.
 *
 * The job record is server-owned and restart-recoverable, so this is derived
 * from it rather than from the agent's `modal_*` tool call. The lead's own
 * `modal_run`/`modal_wait` call is still recorded by the recorder as an opaque
 * tool (its scan-diff sees the outputs land), so a remote artifact usually has
 * two producing steps: the agent's call, and this one naming the instance, the
 * remote command, and the image it ran in.
 */
import fs from "node:fs";
import path from "node:path";
import type { ModalJob } from "../modal/types.ts";
import { resolvePaths } from "../projects.ts";
import { isValidSessionId } from "../agent/notebook-store.ts";
import { isUserVisible, isWithin } from "../sandbox-fs.ts";
import {
  appendNewSteps,
  PROVENANCE_SCHEMA_VERSION,
  type ArtifactRef,
  type ProvenanceStep,
} from "./store.ts";

/** Stable per job, so recovery paths that reach the terminal transition twice
 *  cannot double-record. */
export function modalStepId(jobId: string): string {
  return `modal:${jobId}`;
}

function mtimeNow(sandboxRoot: string, rel: string, fallback: number): number {
  const abs = path.resolve(sandboxRoot, rel);
  if (!isWithin(sandboxRoot, abs) || !isUserVisible(abs, sandboxRoot)) return fallback;
  try {
    return fs.statSync(abs).mtimeMs;
  } catch {
    return fallback;
  }
}

/** Pure mapping from a terminal job to a step. */
export function modalJobStep(job: ModalJob, sandboxRoot: string): ProvenanceStep {
  const startedAt = job.runningAt ?? job.preparingAt ?? job.queuedAt ?? job.createdAt;
  const finishedAt = job.finishedAt ?? job.updatedAt ?? Date.now();
  const inputs: ArtifactRef[] = job.inputFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    mtimeMs: mtimeNow(sandboxRoot, file.path, startedAt),
    change: "read",
    confidence: "observed",
  }));
  // Installed atomically by collectOutputs; whether the path existed before
  // is not known here, so `wrote` rather than a created/modified guess.
  const outputs: ArtifactRef[] = job.outputFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    mtimeMs: mtimeNow(sandboxRoot, file.path, finishedAt),
    change: "wrote",
    confidence: "observed",
  }));
  const instance = job.effectiveInstance ?? job.request.instance;
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: modalStepId(job.id),
    sessionId: job.owner.sessionId,
    ...(job.owner.runId ? { runId: job.owner.runId } : {}),
    startedAt,
    timestamp: finishedAt,
    toolName: "modal_job",
    args: {
      command: job.request.command,
      instance,
      ...(job.request.gpuCount > 1 ? { gpuCount: job.request.gpuCount } : {}),
      ...(job.request.filesIn?.length ? { filesIn: job.request.filesIn } : {}),
      ...(job.request.filesOut?.length ? { filesOut: job.request.filesOut } : {}),
      ...(job.request.image ? { image: job.request.image } : {}),
      ...(job.request.environment ? { environment: job.request.environment } : {}),
      ...(job.request.label ? { label: job.request.label } : {}),
    },
    ...(job.state !== "succeeded" ? { isError: true } : {}),
    role: "compute",
    inputs,
    outputs,
    compute: {
      provider: "modal",
      jobId: job.id,
      state: job.state,
      instance,
      ...(job.effectiveGpu !== undefined ? { gpu: job.effectiveGpu } : {}),
      ...(job.request.environment ? { environment: job.request.environment } : {}),
      ...(job.request.image ? { image: job.request.image } : {}),
      ...(job.sandboxId ? { sandboxId: job.sandboxId } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.missingOutputs.length ? { missingOutputs: job.missingOutputs } : {}),
      submittedBy: job.owner.submittedBy,
    },
  };
}

/**
 * Record a terminal job in its owner session's log. Idempotent (stable id +
 * appendNewSteps) and non-throwing: a provenance failure must never change a
 * job's outcome. Returns whether a row was written.
 */
export function recordModalJobStep(job: ModalJob, onError?: (err: unknown) => void): boolean {
  try {
    if (!isValidSessionId(job.owner.sessionId)) return false;
    const sandboxRoot = resolvePaths(job.projectId).sandbox;
    const step = modalJobStep(job, sandboxRoot);
    return appendNewSteps(job.owner.sessionId, [step], job.projectId).length > 0;
  } catch (err) {
    onError?.(err);
    return false;
  }
}
