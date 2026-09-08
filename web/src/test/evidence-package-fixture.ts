import type { EvidencePackagePreview } from "../lib/evidence-packages";
export const evidenceRoot = { sessionId: "s1", entryId: "h1" };
export const evidencePreview: EvidencePackagePreview = {
  id: "ep_" + "a".repeat(32), projectId: "project-a", createdAt: 1000, digest: "b".repeat(64), zipSha256: "c".repeat(64), zipBytes: 100,
  files: [{ path: "manifest.json", sha256: "d".repeat(64), size: 100 }],
  manifest: { schemaVersion: 1, id: "ep_" + "a".repeat(32), projectId: "project-a", title: "Evidence for treatment effect", createdAt: 1000,
    options: { title: "Evidence for treatment effect", roots: [evidenceRoot], includeArtifacts: true, includeCurrentUnverified: false, includeCommandArguments: false },
    records: [{ key: "record-one", source: evidenceRoot, title: "Treatment effect in discovery cohort", type: "hypothesis", author: "agent", timestamp: 1000, sourceDigest: "e".repeat(64), archivePath: "records/record-one.json", selection: "root", status: "active" }],
    relationships: [], metadataFiles: ["metadata/evidence.json", "metadata/provenance.json"],
    artifacts: [{ id: "artifact-one", path: "figures/result.png", expectedSha256: "1".repeat(64), sha256: "1".repeat(64), size: 4096, archivePath: "artifacts/result.png", basis: "citation", status: "included-matched", origin: "retained-snapshot", references: ["record-one"], reason: "Matches the recorded citation identity; not scientific validation" },
      { id: "artifact-two", path: "data/old-counts.csv", expectedSha256: "2".repeat(64), basis: "consumed-input", status: "unavailable", references: ["step-one"], reason: "Historical bytes were not retained; current data differs" }],
    issues: [{ code: "not-reproduced", message: "No analysis was rerun" }, { code: "historical-bytes-unavailable", subject: "data/old-counts.csv", message: "Original input version could not be recovered" }],
    reproduction: { status: "not-run", reason: "Packaging only" }, methods: { path: "methods-source.md", kind: "source-linked-scaffold", independentlyVerified: false },
  },
};
