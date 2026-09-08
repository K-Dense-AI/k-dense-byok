/** Local idempotency receipts for one-shot planning calls. An interrupted model
 * request is never automatically repeated after restart. No auth data stored. */
import fs from "node:fs";
import { NEXT_EXPERIMENT_REQUEST_ID } from "../../../web/src/lib/next-experiments.ts";
import path from "node:path";
import { managedPath, publishExclusiveJson, readManagedJson } from "../modal/approved.ts";
import { jsonDigest } from "../canonical-json.ts";
import type { NotebookEntry } from "./notebook-store.ts";
export interface GenerationOutcome {
  projectId: string;
  requestDigest: string;
  state: "succeeded" | "failed";
  entry?: NotebookEntry;
  error?: { status: number; code: string; message: string; costUsd?: number };
}
export function generationDirectory(projectId: string, source: { sessionId: string; entryId: string }, requestId: string): string {
  if (!NEXT_EXPERIMENT_REQUEST_ID.test(requestId)) throw new Error("Invalid generation id");
  return managedPath(projectId, `.kady/notebook/next-experiment-generations/${jsonDigest(source)}/${requestId}`);
}
export function readGeneration(projectId: string, source: { sessionId: string; entryId: string }, requestId: string, requestDigest: string): GenerationOutcome | "pending" | undefined {
  const dir = generationDirectory(projectId, source, requestId);
  if (!fs.existsSync(path.join(dir, "intent.json"))) return;
  const intent = readManagedJson<{ projectId: string; requestDigest: string }>(path.join(dir, "intent.json"));
  if (intent.projectId !== projectId || intent.requestDigest !== requestDigest) throw new Error("Generation request id was reused with different inputs or project");
  if (!fs.existsSync(path.join(dir, "outcome.json"))) return "pending";
  const outcome = readManagedJson<GenerationOutcome>(path.join(dir, "outcome.json"), 384 * 1024);
  if (outcome.projectId !== projectId || outcome.requestDigest !== requestDigest || !["succeeded", "failed"].includes(outcome.state)) throw new Error("Generation receipt is inconsistent");
  return outcome;
}
export function beginGeneration(projectId: string, source: { sessionId: string; entryId: string }, requestId: string, requestDigest: string): string {
  const dir = generationDirectory(projectId, source, requestId);
  const root = path.dirname(dir);
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).filter((n) => NEXT_EXPERIMENT_REQUEST_ID.test(n)).length >= 100) throw new Error("Planning-call receipt limit reached for this hypothesis; preserve the history and use a new hypothesis");
  publishExclusiveJson(path.join(dir, "intent.json"), { projectId, source, requestId, requestDigest, createdAt: Date.now() });
  return dir;
}
export function inspectGeneration(projectId: string, source: { sessionId: string; entryId: string }, requestId: string) {
  const dir = generationDirectory(projectId, source, requestId);
  const file = path.join(dir, "intent.json");
  if (!fs.existsSync(file)) return { state: "not-started" as const };
  const intent = readManagedJson<{ projectId: string; source: unknown; requestDigest: string; createdAt: number }>(file);
  if (intent.projectId !== projectId || jsonDigest(intent.source) !== jsonDigest(source)) throw new Error("Generation belongs to a different project/source");
  const outcome = readGeneration(projectId, source, requestId, intent.requestDigest);
  return outcome === "pending" ? { state: "unconfirmed" as const, createdAt: intent.createdAt } : { state: outcome!.state, createdAt: intent.createdAt, error: outcome!.error, proposalSource: outcome!.entry ? { sessionId: source.sessionId, entryId: outcome!.entry.id } : undefined };
}
export function finishGeneration(dir: string, outcome: GenerationOutcome): void {
  if (fs.existsSync(path.join(dir, "outcome.json"))) return;
  publishExclusiveJson(path.join(dir, "outcome.json"), outcome);
}
