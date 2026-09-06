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
import { readEnvironment, type EnvironmentSnapshot } from "./environment.ts";
import {
  identify,
  readProjectSteps,
  type EdgeConfidence,
  type FileIdentity,
  type ProvenanceStep,
} from "./store.ts";

/** How many `read` steps to return. Inputs are read far more often than
 *  written, and the full list is rarely what anyone wants. */
export const MAX_READ_BY = 20;

/** Upstream walk budget. A figure rarely sits more than a handful of steps
 *  from its raw data; past this the walk stops and says so. */
export const MAX_LINEAGE_NODES = 60;
export const MAX_LINEAGE_DEPTH = 12;

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

/** Why an upstream walk stopped at this file. */
export type LineageRoot =
  /** The user uploaded it — the natural origin of a chain. */
  | "upload"
  /** The user created it in the editor, from nothing recorded. */
  | "user"
  /** Nothing recorded produced the version that was consumed: it predates
   *  provenance, arrived outside the API, or its producing scan degraded. */
  | "unrecorded"
  /** The walk hit its depth/node budget here. */
  | "budget";

export interface LineageNode {
  path: string;
  /** Hops upstream of the requested artifact (0 = the artifact itself). */
  depth: number;
  /**
   * Id of the step that produced the VERSION consumed downstream — the newest
   * producing step at or before the consuming step ran — not necessarily the
   * newest producer overall. Absent for an unrecorded root.
   */
  stepId?: string;
  root?: LineageRoot;
  /** Identity on disk now; null when the file is gone. */
  current: { sha256?: string; size: number; mtimeMs: number } | null;
  /**
   * Whether the bytes on disk differ from the version the downstream step
   * consumed. True is the hazard: the figure was built from data that has
   * since changed. Null when either side lacks a hash. Undefined for depth 0
   * (that is `staleness`).
   */
  changedSinceUse?: boolean | null;
}

export interface LineageEdge {
  /** Input path. */
  from: string;
  /** Output path. */
  to: string;
  stepId: string;
  /** The INPUT edge's confidence — an inferred input is a lead, not a fact. */
  confidence: EdgeConfidence;
}

export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** Every step referenced by a node or edge, by id. */
  steps: Record<string, ProvenanceStep>;
  truncated: boolean;
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
  /** Transitive upstream inputs, back to uploads or the edge of the record. */
  lineage: Lineage;
  /** Environment snapshots referenced by any returned step, by id. */
  environments: Record<string, EnvironmentSnapshot>;
}

function publicIdentity(identity: FileIdentity | null) {
  return identity
    ? {
        ...(identity.sha256 ? { sha256: identity.sha256 } : {}),
        size: identity.size,
        mtimeMs: identity.mtimeMs,
      }
    : null;
}

/** Newest step that wrote the path at or before `at` (any time when undefined).
 *  `producers` is timestamp-ascending, as readProjectSteps returns it. */
function producerAtOrBefore(
  producers: ProvenanceStep[] | undefined,
  at: number | undefined,
): ProvenanceStep | undefined {
  if (!producers) return undefined;
  for (let i = producers.length - 1; i >= 0; i--) {
    const step = producers[i];
    if (at === undefined || step.timestamp <= at) return step;
  }
  return undefined;
}

function rootKind(step: ProvenanceStep, rel: string): LineageRoot | undefined {
  if (step.role !== "user") return undefined;
  if (step.toolName === "upload") return "upload";
  // A file the user created from scratch in the editor. An in-place edit of an
  // existing file is NOT a root: the earlier versions sit in "Produced by".
  const created = step.outputs.some((ref) => ref.path === rel && ref.change === "created");
  return step.toolName === "save" && created ? "user" : undefined;
}

/**
 * Walk upstream from `rel` through input edges, version-aware.
 *
 * Each hop picks the producer of the version that was actually consumed: the
 * newest step that wrote the input at or before the consuming step ran. So a
 * figure built from Tuesday's counts.csv points at Tuesday's step even if the
 * file was regenerated Wednesday — and `changedSinceUse` then says so.
 *
 * One node per path: if two consumers used different versions of the same
 * input, the first-reached consumer's version wins. Bounded by node count and
 * depth; `truncated` reports either budget being hit.
 */
export function walkLineage(
  sandbox: string,
  rel: string,
  steps: ProvenanceStep[],
): Lineage {
  const byOutput = new Map<string, ProvenanceStep[]>();
  for (const step of steps) {
    for (const ref of step.outputs) {
      if (ref.change === "deleted" || ref.change === "read") continue;
      const list = byOutput.get(ref.path) ?? [];
      list.push(step);
      byOutput.set(ref.path, list);
    }
  }

  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const stepsById: Record<string, ProvenanceStep> = {};
  const visited = new Set<string>([rel]);
  let truncated = false;

  interface Pending {
    path: string;
    depth: number;
    at?: number;
    /** Hash of the version the downstream step consumed. */
    consumedSha256?: string;
  }
  const queue: Pending[] = [{ path: rel, depth: 0 }];

  while (queue.length > 0) {
    if (nodes.length >= MAX_LINEAGE_NODES) {
      truncated = true;
      break;
    }
    const pending = queue.shift()!;
    const identity = identify(path.resolve(sandbox, pending.path));
    const node: LineageNode = {
      path: pending.path,
      depth: pending.depth,
      current: publicIdentity(identity),
    };
    if (pending.depth > 0) {
      node.changedSinceUse =
        identity?.sha256 && pending.consumedSha256
          ? identity.sha256 !== pending.consumedSha256
          : null;
    }

    const producer = producerAtOrBefore(byOutput.get(pending.path), pending.at);
    if (!producer) {
      node.root = "unrecorded";
      nodes.push(node);
      continue;
    }
    node.stepId = producer.id;
    stepsById[producer.id] = producer;
    const root = rootKind(producer, pending.path);
    if (root) {
      node.root = root;
      nodes.push(node);
      continue;
    }
    // An in-place edit lists the file's previous version as its own input.
    // That is version history, not lineage — following it would draw a
    // self-edge — so the walk only continues through OTHER paths.
    const upstream = producer.inputs.filter((input) => input.path !== pending.path);
    if (upstream.length === 0) {
      // A producing step with no inputs is an opaque call whose reads we could
      // not see (or a genuine origin such as a generated file). Not a root in
      // the "this is where it came from" sense, so no root kind — the UI shows
      // the step and stops.
      nodes.push(node);
      continue;
    }
    if (pending.depth >= MAX_LINEAGE_DEPTH) {
      node.root = "budget";
      truncated = true;
      nodes.push(node);
      continue;
    }
    nodes.push(node);
    const consumedAt = producer.startedAt ?? producer.timestamp;
    for (const input of upstream) {
      edges.push({
        from: input.path,
        to: pending.path,
        stepId: producer.id,
        confidence: input.confidence,
      });
      if (visited.has(input.path)) continue;
      visited.add(input.path);
      queue.push({
        path: input.path,
        depth: pending.depth + 1,
        at: consumedAt,
        ...(input.sha256 ? { consumedSha256: input.sha256 } : {}),
      });
    }
  }
  if (queue.length > 0) truncated = true;

  return { nodes, edges, steps: stepsById, truncated };
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
      const same = identity.sha256 === latestRef.sha256;
      // A harvest-time hash was measured when the subagent's session file was
      // parsed, not when the step wrote the file, so agreement only proves
      // "unchanged since we looked" — never "this is what produced it". Report
      // that as unknown rather than borrowing confidence we did not earn. A
      // MISmatch is still decisive: the bytes definitely changed.
      const identityIsRetrospective = latestRef.identityAt === "harvest";
      staleness = same ? (identityIsRetrospective ? "unknown" : "current") : "stale";
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

  const lineage = walkLineage(sandbox, rel, steps);

  const environments: Record<string, EnvironmentSnapshot> = {};
  const referenced = [...producedBy, ...Object.values(lineage.steps)];
  for (const step of referenced) {
    const id = step.environmentId;
    if (!id || environments[id]) continue;
    const snapshot = readEnvironment(id, projectId);
    if (snapshot) environments[id] = snapshot;
  }

  return {
    path: rel,
    exists: identity !== null,
    current: publicIdentity(identity),
    producedBy,
    readBy: readBy.slice(0, MAX_READ_BY),
    readByTotal: readBy.length,
    citedBy,
    staleness,
    lineage,
    environments,
  };
}
