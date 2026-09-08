/** IO-free protocol for local reviewer evidence packages. Packaging is not reproduction. */
export interface EvidenceRoot { sessionId: string; entryId: string }
export interface EvidencePackageRequest {
  title: string;
  roots: EvidenceRoot[];
  includeArtifacts: boolean;
  includeCurrentUnverified: boolean;
  includeCommandArguments: boolean;
}
export interface EvidenceIssue { code: string; message: string; subject?: string }
export interface EvidenceRecordRef {
  key: string;
  source: EvidenceRoot;
  title: string;
  type: string;
  author: string;
  timestamp: number;
  sourceDigest: string;
  archivePath: string;
  selection: "root" | "linked";
  status: "active" | "superseded" | "unknown";
}
export type EvidenceIdentityBasis = "citation" | "output" | "consumed-input" | "plan" | "retrospective" | "unknown";
export interface EvidenceArtifact {
  id: string;
  path: string;
  expectedSha256?: string;
  sha256?: string;
  size?: number;
  archivePath?: string;
  basis: EvidenceIdentityBasis;
  status: "included-matched" | "included-current-unverified" | "unavailable" | "excluded";
  origin?: "current" | "retained-snapshot" | "modal-output" | "robustness-input";
  references: string[];
  reason?: string;
}
export interface EvidenceRelationship { from: string; to: string; relation: string; resolved: boolean }
export interface EvidencePackageManifest {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  options: EvidencePackageRequest;
  records: EvidenceRecordRef[];
  relationships: EvidenceRelationship[];
  artifacts: EvidenceArtifact[];
  metadataFiles: string[];
  issues: EvidenceIssue[];
  reproduction: { status: "not-run"; reason: string };
  methods: { path: string; kind: "source-linked-scaffold"; independentlyVerified: false };
}
export interface EvidencePackagePreview {
  id: string;
  projectId: string;
  createdAt: number;
  digest: string;
  zipSha256: string;
  zipBytes: number;
  manifest: EvidencePackageManifest;
  files: { path: string; sha256: string; size: number }[];
}
export interface EvidenceStorage {
  snapshotsBytes: number;
  packagesBytes: number;
  snapshotsLimitBytes: number;
  packagesLimitBytes: number;
  packageCount: number;
  packageLimit: number;
}
export const EVIDENCE_PACKAGE_NOTICE = "This is a local evidence snapshot, not a reproduced analysis, independent scientific validation, external preregistration or a publication license. Missing/changed/unverified evidence remains explicit. No analysis, package installation, model call or remote compute is executed by packaging. Review confidential data and redistribution rights before sharing.";
export function normalizeEvidencePackageRequest(raw: unknown): EvidencePackageRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Package request must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 200) throw new Error("Package title is required (maximum 200 characters)");
  if (!Array.isArray(r.roots) || r.roots.length < 1 || r.roots.length > 8) throw new Error("Select 1–8 notebook roots");
  const roots = new Map<string, EvidenceRoot>();
  for (const source of r.roots) {
    if (!source || typeof source.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(source.sessionId) || typeof source.entryId !== "string" || !source.entryId.trim() || source.entryId.length > 500 || source.entryId.includes("\0")) throw new Error("Invalid notebook source");
    const ref = { sessionId: source.sessionId, entryId: source.entryId };
    roots.set(JSON.stringify(ref), ref);
  }
  for (const key of ["includeArtifacts", "includeCurrentUnverified", "includeCommandArguments"]) if (typeof r[key] !== "boolean") throw new Error(`${key} must be explicitly selected`);
  return { title: r.title.trim(), roots: [...roots.values()], includeArtifacts: r.includeArtifacts as boolean, includeCurrentUnverified: r.includeCurrentUnverified as boolean, includeCommandArguments: r.includeCommandArguments as boolean };
}
