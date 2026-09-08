import { loadMemoryCorpus, type MemoryDocument } from "../agent/notebook-memory-loader.ts";
import { deriveEvidenceThreads, evidenceLinks, notebookEntryKey, notebookTargetKey } from "../../../web/src/lib/notebook-evidence-core.ts";
import { experimentSources } from "../../../web/src/lib/next-experiments.ts";
import { jsonDigest } from "../canonical-json.ts";
import { EvidencePackageError } from "./storage.ts";
import type { EvidenceRoot, EvidenceIssue, EvidenceRelationship, EvidenceRecordRef } from "../../../web/src/lib/evidence-packages.ts";
export interface PackageRecord { ref: EvidenceRecordRef; document: MemoryDocument }
export const MAX_PACKAGE_RECORDS = 64;
export async function packageRecordGraph(projectId: string, roots: EvidenceRoot[], issues: EvidenceIssue[]) {
  const corpus = await loadMemoryCorpus(projectId, { kind: "notebook", ...roots[0] }, { retainOriginal: true });
  for (const warning of corpus.coverage.warnings) issues.push({ code: "notebook-scan-incomplete", message: warning });
  const docs = corpus.documents.filter((d) => d.source.kind === "notebook");
  const sourceKey = (s: EvidenceRoot) => notebookEntryKey({ id: s.entryId, sessionId: s.sessionId });
  const byKey = new Map(docs.map((d) => [sourceKey(d.source), d]));
  const threads = deriveEvidenceThreads(docs.map((d) => ({ ...d.entry, sessionId: d.source.sessionId })));
  const allEdges: { from: string; to: string; relation: string }[] = [];
  const adjacent = new Map<string, Set<string>>();
  const add = (from: string, to: string, relation: string) => {
    allEdges.push({ from, to, relation });
    for (const [a, b] of [[from, to], [to, from]]) { const list = adjacent.get(a) ?? new Set(); list.add(b); adjacent.set(a, list); }
  };
  for (const d of docs) {
    const key = sourceKey(d.source);
    for (const link of evidenceLinks(d.entry)) add(key, notebookTargetKey({ sessionId: d.source.sessionId }, link.entryId, link.sessionId), link.relation);
    if (d.entry.supersedes) add(key, notebookTargetKey({ sessionId: d.source.sessionId }, d.entry.supersedes), "supersedes");
    // These edges preserve a proposal's grounding, not supporting evidence.
    // Plan-event references reach their owning hypothesis and normal plan export.
    if (d.entry.nextExperiments) for (const ref of experimentSources(d.entry.nextExperiments)) {
      if (ref.kind !== "user-note") add(key, notebookTargetKey({ sessionId: d.source.sessionId }, ref.entryId, ref.sessionId), "planning source (not evidence)");
    }
  }
  const rootKeys = new Set(roots.map(sourceKey));
  for (const key of rootKeys) if (!byKey.has(key)) throw new EvidencePackageError("ROOT_UNAVAILABLE", "A selected root could not be resolved uniquely within the bounded notebook scan. Select it separately or inspect the original notebook.", 413);
  const queue = [...rootKeys].map((key) => ({ key, depth: 0 })); const chosen = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (chosen.has(item.key) || !byKey.has(item.key)) continue;
    if (chosen.size >= MAX_PACKAGE_RECORDS) { issues.push({ code: "evidence-graph-limit", message: "Evidence/amendment graph stopped at 64 records; omitted context is not verified absent" }); break; }
    chosen.add(item.key);
    const more = [...(adjacent.get(item.key) ?? [])].filter((key) => !chosen.has(key));
    if (item.depth >= 3) { if (more.length) issues.push({ code: "evidence-depth-limit", subject: item.key, message: "Evidence closure is bounded to three links from selected roots" }); continue; }
    for (const key of more) queue.push({ key, depth: item.depth + 1 });
  }
  const records: PackageRecord[] = [...chosen].map((key) => {
    const document = byKey.get(key)!;
    if (!document.original) throw new EvidencePackageError("SOURCE_UNAVAILABLE", "Original source bytes were not retained for packaging", 503);
    const id = `record-${jsonDigest(key).slice(0, 24)}`;
    return { document, ref: { key: id, source: { sessionId: document.source.sessionId, entryId: document.source.entryId }, title: document.entry.title, type: document.entry.type, author: document.entry.role, timestamp: document.entry.timestamp, sourceDigest: document.digest,
      archivePath: `records/${id}.json`, selection: rootKeys.has(key) ? "root" : "linked", status: threads.get(key)?.supersededBy ? "superseded" : corpus.coverage.complete ? "active" : "unknown" } };
  });
  for (const record of records) {
    const plan = record.document.entry.nextExperiments;
    if (plan && experimentSources(plan).some((r) => r.kind === "user-note")) issues.push({ code: "planning-user-note-reference", subject: record.ref.key, message: "Planning references to standalone user notes are retained as source ids; this notebook graph does not verify/package their cited historical version." });
  }
  const recordKeys = new Map(records.map((r) => [sourceKey(r.ref.source), r.ref.key]));
  const relationships: EvidenceRelationship[] = allEdges.filter((e) => chosen.has(e.from) || chosen.has(e.to)).slice(0, 512).map((e) => ({ from: recordKeys.get(e.from) ?? e.from, to: recordKeys.get(e.to) ?? e.to, relation: e.relation, resolved: chosen.has(e.from) && chosen.has(e.to) }));
  if (allEdges.filter((e) => chosen.has(e.from) || chosen.has(e.to)).length > 512) issues.push({ code: "relationship-limit", message: "Additional evidence relationships were not serialized after 512 edges" });
  if (relationships.some((e) => !e.resolved)) issues.push({ code: "unresolved-evidence", message: "Some linked evidence/amendments were unavailable or outside the selected bounded closure" });
  return { records, relationships, coverage: corpus.coverage };
}
