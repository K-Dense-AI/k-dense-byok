import type { MemoryHit, MemorySearchResponse, MemoryRecordResponse } from "../lib/notebook-memory";
export const memoryHit: MemoryHit = {
  source: { kind: "notebook", sessionId: "older-chat", entryId: "decision-1" },
  sourceUri: "/projects/project-a/notebook/memory/record?project=project-a&source=fixture",
  digest: "a".repeat(64), type: "decision", title: "Rejected Harmony integration", timestamp: 1000, author: "agent",
  scope: "Discovery cohort v2", revisitWhen: "A site-balanced validation cohort is available", limitations: ["Treatment was confounded with site"], tags: ["integration"],
  excerpt: "Harmony removed treatment-associated structure along with batch variation.", excerptTruncated: true, matchedFields: ["title", "body"], recordStatus: "superseded",
  qualifiers: ["Superseded history: read the amendment before reuse.", "A technical failure is not evidence of no effect.", "Direct artifact checks are not scientific verification."],
  artifactHealth: [{ path: "results/integration.csv", status: "changed", reason: "Bytes differ from the recorded output", checkedAt: 2000 }], artifactsUnchecked: 0,
  related: [{ source: { kind: "notebook", sessionId: "older-chat", entryId: "decision-2" }, title: "Reconsider with balanced controls", relation: "superseded by", digest: "b".repeat(64) }],
};
export const memorySearch: MemorySearchResponse = { projectId: "project-a", query: "Harmony", hits: [memoryHit], totalMatches: 1, checkedAt: 2000, coverage: { complete: true, scannedFiles: 2, scannedBytes: 1000, indexedRecords: 2, skippedRecords: 0, warnings: [] } };
export const memoryRecord: MemoryRecordResponse = { projectId: "project-a", hit: memoryHit, entry: { id: "decision-1", type: "decision", title: memoryHit.title, timestamp: 1000, role: "agent", body: "Original **Markdown** is shown as text. <img src=\"https://example.com/should-not-load\">", confidence: "medium", scope: memoryHit.scope, revisitWhen: memoryHit.revisitWhen }, truncated: false, changedSinceSearch: false, coverage: memorySearch.coverage };
