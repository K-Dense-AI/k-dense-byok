/**
 * Artifact-centric queries over the provenance step log.
 *
 * The store is append-only and step-ordered; the question a scientist actually
 * asks is the inverse — "where did THIS figure come from?" — so this module
 * indexes by path.
 *
 * The staleness check is the load-bearing part. A notebook entry citing
 * `fig3.png` is a claim about the bytes that existed when it was written; if the
 * figure was regenerated afterward, the citation silently points at something
 * else. Hashes make that detectable, and detecting it is most of the reason to
 * hash at all.
 */
import path from "node:path";
import {
  readProjectNotebooks,
  type NotebookEntry,
} from "../agent/notebook-store.ts";
import { resolvePaths } from "../projects.ts";
import { apiRelative, isUserVisible, isWithin } from "../sandbox-fs.ts";
import { identify, readProjectSteps, type ProvenanceStep } from "./store.ts";

/** How many `read` steps to return. Inputs are read far more often than
 *  written, and the full list is rarely what anyone wants. */
export const MAX_READ_BY = 20;

export type Staleness =
  /** Current bytes match what the newest producing step recorded. */
  | "current"
  /** Current bytes differ — the file changed after it was produced. */
  | "stale"
  /** No hash on one side (file too large, unreadable, or never produced here). */
  | "unknown";

export interface NotebookCitation {
  id: string;
  sessionId: string;
  type: NotebookEntry["type"];
  title: string;
  timestamp: number;
  role: string;
  runId?: string;
  /**
   * The entry was written before the newest producing step, so it cites an
   * earlier version of this artifact than the one on disk.
   */
  precedesLatestOutput: boolean;
}

export interface ArtifactProvenance {
  path: string;
  exists: boolean;
  current: { sha256?: string; size: number; mtimeMs: number } | null;
  /** Steps that created/modified/deleted this path, newest first. */
  producedBy: ProvenanceStep[];
  /** Steps that read it, newest first, capped at MAX_READ_BY. */
  readBy: ProvenanceStep[];
  readByTotal: number;
  citedBy: NotebookCitation[];
  staleness: Staleness;
}

function outputRefFor(step: ProvenanceStep, rel: string) {
  return step.outputs.find((ref) => ref.path === rel);
}

/**
 * Assemble everything known about one sandbox-relative path.
 *
 * Project-scoped on purpose: a figure opened in one chat tab is routinely
 * produced by another, so a session-scoped answer would report "no provenance"
 * for a file that has plenty.
 */
export function artifactProvenance(
  projectId: string,
  requestedPath: string,
): ArtifactProvenance {
  const sandbox = resolvePaths(projectId).sandbox;
  const abs = path.resolve(sandbox, requestedPath);
  if (!isWithin(sandbox, abs) || !isUserVisible(abs, sandbox)) {
    throw new Error(`Path is not a user-visible sandbox file: ${requestedPath}`);
  }
  // Edges are stored in wire form relative to the sandbox root. Re-derive that
  // spelling so "./fig.png" or a native-separator path still matches.
  const rel = apiRelative(sandbox, abs);

  const identity = identify(abs);
  const steps = readProjectSteps(projectId);

  const producedBy: ProvenanceStep[] = [];
  const readBy: ProvenanceStep[] = [];
  for (const step of steps) {
    if (outputRefFor(step, rel)) producedBy.push(step);
    else if (step.inputs.some((ref) => ref.path === rel)) readBy.push(step);
  }
  // Newest first: "what most recently touched this" is the common question.
  producedBy.reverse();
  readBy.reverse();

  const latest = producedBy[0];
  const latestRef = latest ? outputRefFor(latest, rel) : undefined;
  let staleness: Staleness = "unknown";
  if (identity && latestRef) {
    if (identity.sha256 && latestRef.sha256) {
      staleness = identity.sha256 === latestRef.sha256 ? "current" : "stale";
    } else if (identity.size === latestRef.size && identity.mtimeMs === latestRef.mtimeMs) {
      // No hash on one side (too large / unreadable). Size+mtime agreement is
      // weak evidence of sameness, so this stays "unknown" rather than
      // claiming a verification we did not perform.
      staleness = "unknown";
    } else {
      staleness = "stale";
    }
  }

  const citedBy: NotebookCitation[] = [];
  for (const { sessionId, entries } of readProjectNotebooks(projectId)) {
    for (const entry of entries) {
      if (!entry.artifacts?.includes(rel)) continue;
      citedBy.push({
        id: entry.id,
        sessionId,
        type: entry.type,
        title: entry.title,
        timestamp: entry.timestamp,
        role: entry.role,
        ...(entry.runId ? { runId: entry.runId } : {}),
        precedesLatestOutput: latest ? entry.timestamp < latest.timestamp : false,
      });
    }
  }
  citedBy.sort((a, b) => b.timestamp - a.timestamp);

  return {
    path: rel,
    exists: identity !== null,
    current: identity
      ? {
          ...(identity.sha256 ? { sha256: identity.sha256 } : {}),
          size: identity.size,
          mtimeMs: identity.mtimeMs,
        }
      : null,
    producedBy,
    readBy: readBy.slice(0, MAX_READ_BY),
    readByTotal: readBy.length,
    citedBy,
    staleness,
  };
}
