"use client";

/**
 * Provenance client. Answers "where did this file come from?" for one
 * sandbox-relative path, project-scoped (apiFetch injects X-Project-Id).
 *
 * The server derives all of this by observing the agent's tool calls, so
 * `confidence` on an edge is meaningful and must be surfaced, not flattened —
 * an inferred edge is a lead, not a fact.
 */
import { apiFetch } from "@/lib/projects";

export type EdgeConfidence = "observed" | "inferred" | "declared";

export type ArtifactChange = "created" | "modified" | "deleted" | "read" | "unchanged";

export type Staleness = "current" | "stale" | "unknown";

/** Why a step's file attribution is less complete than usual. */
export type DegradeReason = "sandbox-too-large" | "scan-failed";

export interface ArtifactRef {
  path: string;
  sha256?: string;
  size: number;
  mtimeMs: number;
  change: ArtifactChange;
  confidence: EdgeConfidence;
  hashSkipped?: "too-large" | "unreadable";
}

export interface ProvenanceStep {
  schemaVersion: number;
  id: string;
  sessionId: string;
  runId?: string;
  startedAt?: number;
  timestamp: number;
  toolName: string;
  args?: unknown;
  isError?: boolean;
  model?: string;
  role: "agent" | "subagent";
  agentName?: string;
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  degraded?: DegradeReason;
  truncatedEdges?: number;
}

export interface NotebookCitation {
  id: string;
  sessionId: string;
  type: "hypothesis" | "method" | "observation" | "decision" | "note";
  title: string;
  timestamp: number;
  role: string;
  runId?: string;
  precedesLatestOutput: boolean;
}

export interface ArtifactProvenance {
  path: string;
  exists: boolean;
  current: { sha256?: string; size: number; mtimeMs: number } | null;
  producedBy: ProvenanceStep[];
  readBy: ProvenanceStep[];
  readByTotal: number;
  citedBy: NotebookCitation[];
  staleness: Staleness;
}

export async function getArtifactProvenance(
  path: string,
  projectId?: string,
): Promise<ArtifactProvenance> {
  const res = await apiFetch(
    `/sandbox/provenance?path=${encodeURIComponent(path)}`,
    {},
    projectId,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `getArtifactProvenance ${res.status}`);
  }
  return (await res.json()) as ArtifactProvenance;
}
