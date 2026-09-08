/** Source-linked research recall, never a model-authored permanent fact store. */
import { withNotebookArtifactHealth } from "./notebook-artifacts.ts";
import { loadMemoryCorpus, type MemoryCorpus, type MemoryDocument } from "./notebook-memory-loader.ts";
import { deriveEvidenceThreads, evidenceLinks, notebookEntryKey, notebookTargetKey } from "../../../web/src/lib/notebook-evidence-core.ts";
import { normalizeMemoryQuery, normalizeMemorySource, memorySourceKey, memorySearchFields, memoryExcerpt, rankMemory, MEMORY_RULES,
  type MemoryCoverage, type MemoryHit, type MemoryRecordResponse, type MemorySearchResponse, type MemorySource } from "../../../web/src/lib/notebook-memory.ts";
import type { NotebookEntry } from "./notebook-store.ts";

export class NotebookMemoryError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
export function sourceUri(projectId: string, source: MemorySource, digest?: string): string {
  return `/projects/${encodeURIComponent(projectId)}/notebook/memory/record?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(JSON.stringify(source))}${digest ? `&expectedDigest=${digest}` : ""}`;
}
function notebookEntries(corpus: MemoryCorpus) {
  return corpus.documents.filter((d) => d.source.kind === "notebook").map((d) => ({ ...d.entry, sessionId: d.source.sessionId }));
}
function relationships(corpus: MemoryCorpus) {
  const entries = notebookEntries(corpus);
  const threads = deriveEvidenceThreads(entries);
  const byEntry = new Map(corpus.documents.filter((d) => d.source.kind === "notebook").map((d) => [notebookEntryKey({ id: d.entry.id, sessionId: d.source.sessionId }), d]));
  const bySource = new Map(corpus.documents.map((d) => [memorySourceKey(d.source), d]));
  return { threads, byEntry, bySource };
}
function recordStatus(document: MemoryDocument, corpus: MemoryCorpus, rel: ReturnType<typeof relationships>): MemoryHit["recordStatus"] {
  if (document.supersededBy || document.source.kind === "notebook" && rel.threads.get(notebookEntryKey({ id: document.entry.id, sessionId: document.source.sessionId }))?.supersededBy) return "superseded";
  if (document.historical) return "historical";
  return corpus.coverage.complete ? "active" : "unknown";
}
export async function hitsFor(projectId: string, corpus: MemoryCorpus, selected: { document: MemoryDocument; matchedFields: string[] }[], query: string): Promise<MemoryHit[]> {
  const rel = relationships(corpus);
  const checks = await withNotebookArtifactHealth(selected.map((s) => s.document.entry), projectId);
  return selected.map(({ document, matchedFields }, index) => {
    const entry = checks[index];
    const key = notebookEntryKey({ id: entry.id, sessionId: document.source.sessionId });
    const thread = document.source.kind === "notebook" ? rel.threads.get(key) : undefined;
    const qualifiers = [...document.qualifiers, "Historical record, not a permanent fact or permission to repeat an action."];
    const related: MemoryHit["related"] = [];
    const add = (target: MemoryDocument | undefined, relation: string, fallback?: MemorySource) => {
      const source = target?.source ?? fallback;
      if (!source || related.some((r) => memorySourceKey(r.source) === memorySourceKey(source) && r.relation === relation)) return;
      if (related.length < 8) related.push({ source, title: target?.entry.title.slice(0, 300) ?? "Source outside the recalled context", relation, ...(target ? { digest: target.digest } : {}) });
      else qualifiers.push("Additional related records are not expanded in this bounded response.");
    };
    if (thread?.supersededBy) add(rel.byEntry.get(thread.supersededBy), "superseded by");
    if (document.supersededBy) add(rel.bySource.get(memorySourceKey(document.supersededBy)), "corrected by", document.supersededBy);
    if (document.source.kind === "notebook") {
      if (entry.supersedes) add(rel.byEntry.get(notebookTargetKey({ sessionId: document.source.sessionId }, entry.supersedes)), "amends", { kind: "notebook", sessionId: document.source.sessionId, entryId: entry.supersedes });
      for (const link of evidenceLinks({ ...entry, sessionId: document.source.sessionId })) {
        const target = { kind: "notebook" as const, sessionId: link.sessionId ?? document.source.sessionId, entryId: link.entryId };
        add(rel.byEntry.get(notebookEntryKey({ id: target.entryId, sessionId: target.sessionId })), link.relation, target);
      }
      for (const incoming of thread?.activeEvidence ?? []) add(rel.byEntry.get(incoming.id), `incoming ${incoming.relation}`);
    } else if (document.source.kind === "plan-event") {
      const parent: MemorySource = { kind: "notebook", sessionId: document.source.sessionId, entryId: document.source.entryId };
      add(rel.bySource.get(memorySourceKey(parent)), "hypothesis", parent);
    }
    const status = recordStatus(document, corpus, rel);
    if (status === "superseded") qualifiers.push("Superseded/corrected history: read the amendment before reusing this record.");
    if (status === "historical") qualifiers.push("Historical plan revision; later revisions exist.");
    if (!corpus.coverage.complete) qualifiers.push("Recall coverage is incomplete; currentness and aggregate evidence status cannot be established from this scan.");
    if (!entry.scope && document.type !== "plan" && document.type !== "deviation") qualifiers.push("Applicability scope was not explicitly recorded; verify the dataset/cohort/conditions before generalizing.");
    if (entry.outcome === "technical-failure") qualifiers.push("Technical failure is not evidence of no effect or a refuted hypothesis.");
    if (entry.outcome === "null") qualifiers.push("A recorded null result is not automatically evidence of equivalence or absence of an effect.");
    if (entry.outcome === "inconclusive") qualifiers.push("Inconclusive evidence does not establish support or refutation.");
    if (document.type === "observation" && !entry.outcome) qualifiers.push("Outcome was not explicitly classified; do not infer one solely from wording.");
    if (thread?.unresolvedLinks) qualifiers.push("Some evidence/amendment references are unresolved in this recalled context.");
    const artifactHealth = entry.artifactHealth ?? [];
    if (artifactHealth.some((c) => c.status === "changed" || c.status === "missing")) qualifiers.push("Needs review: directly cited files changed or are missing. This is not a scientific refutation.");
    if (artifactHealth.some((c) => c.status === "unverified") || entry.artifactHealthTruncated) qualifiers.push("Some direct artifact identities are unverified or exceeded the check budget.");
    if (artifactHealth.length) qualifiers.push("Checks concern direct cited file identities only, not upstream inputs, methods or scientific validity.");
    if (thread?.activeEvidence?.length) qualifiers.push("Linked evidence file identities were not automatically checked; inspect those original records separately.");
    const excerpt = memoryExcerpt(memorySearchFields(entry, document.type), query, matchedFields);
    return { source: document.source, sourceUri: sourceUri(projectId, document.source, document.digest), digest: document.digest, type: document.type,
      title: entry.title, timestamp: entry.timestamp, author: entry.role, outcome: entry.outcome, scope: entry.scope, revisitWhen: entry.revisitWhen,
      limitations: entry.limitations ?? [], tags: entry.tags ?? [], excerpt: excerpt.text, excerptTruncated: excerpt.truncated, matchedFields,
      recordStatus: status, ...(thread?.status ? { evidenceStatus: corpus.coverage.complete ? thread.status : "unknown" as const } : {}),
      qualifiers: [...new Set(qualifiers)].slice(0, 16), artifactHealth, artifactsUnchecked: entry.artifactHealthTruncated ?? 0, related };
  });
}
export async function searchNotebookMemory(projectId: string, input: unknown): Promise<MemorySearchResponse> {
  let query;
  try { query = normalizeMemoryQuery(input); } catch (e) { throw new NotebookMemoryError(400, "INVALID_QUERY", (e as Error).message); }
  const corpus = await loadMemoryCorpus(projectId);
  const rel = relationships(corpus);
  const candidates = corpus.documents.filter((d) => (!query.type || query.type === d.type) && (!query.outcome || query.outcome === d.entry.outcome)
    && (query.includeSuperseded || !["superseded", "historical"].includes(recordStatus(d, corpus, rel))));
  const ranked = rankMemory(candidates, query.query);
  if (!query.query) ranked.sort((a, b) => b.document.entry.timestamp - a.document.entry.timestamp);
  return { projectId, query: query.query, hits: await hitsFor(projectId, corpus, ranked.slice(0, query.limit), query.query), totalMatches: ranked.length, coverage: corpus.coverage, checkedAt: Date.now() };
}
export async function readNotebookMemory(projectId: string, raw: unknown, expectedDigest?: string): Promise<MemoryRecordResponse> {
  let source: MemorySource;
  try { source = normalizeMemorySource(raw); } catch (e) { throw new NotebookMemoryError(400, "INVALID_SOURCE", (e as Error).message); }
  if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new NotebookMemoryError(400, "INVALID_DIGEST", "Expected digest must be a sha256");
  const corpus = await loadMemoryCorpus(projectId, source);
  const document = corpus.documents.find((d) => memorySourceKey(d.source) === memorySourceKey(source));
  if (!document) throw new NotebookMemoryError(corpus.coverage.complete ? 404 : 413, corpus.coverage.complete ? "SOURCE_MISSING" : "SOURCE_UNVERIFIED", corpus.coverage.complete ? "Source record is no longer present" : "Source could not be resolved uniquely within the bounded scan; inspect the original notebook. Absence is not verified.");
  const [hit] = await hitsFor(projectId, corpus, [{ document, matchedFields: [] }], "");
  return { projectId, hit, entry: document.entry as NotebookEntry, truncated: document.qualifiers.some((q) => /bounded|exceeds/.test(q)), changedSinceSearch: expectedDigest !== undefined && expectedDigest !== document.digest, coverage: corpus.coverage };
}

export const MEMORY_TOOL_BYTES = 24 * 1024;
function compactHit(h: MemoryHit) {
  return { ...h, sourceUri: h.sourceUri.length <= 2000 ? h.sourceUri : undefined, title: h.title.slice(0, 300), scope: h.scope?.slice(0, 400), revisitWhen: h.revisitWhen?.slice(0, 400),
    excerpt: h.excerpt.slice(0, 500), excerptTruncated: h.excerptTruncated || h.excerpt.length > 500,
    limitations: h.limitations.slice(0, 3).map((s) => s.slice(0, 300)), tags: h.tags.slice(0, 12),
    related: h.related.slice(0, 2).map((r) => ({ ...r, title: r.title.slice(0, 150) })), relatedOmitted: Math.max(0, h.related.length - 2),
    artifactHealth: h.artifactHealth.slice(0, 2), artifactChecksOmitted: Math.max(0, h.artifactHealth.length - 2),
    limitationsOmitted: Math.max(0, h.limitations.length - 3), limitationTextTruncated: h.limitations.some((s) => s.length > 300),
    scopeTruncated: (h.scope?.length ?? 0) > 400, revisitWhenTruncated: (h.revisitWhen?.length ?? 0) > 400,
    recallFieldsBounded: true,
  };
}
/** This same bounded envelope reaches lead tools and child localhost bridges. */
export async function executeMemoryRecall(projectId: string, input: unknown) {
  const raw = input as Record<string, unknown> | null;
  const action = raw?.action ?? "search";
  let payload: Record<string, unknown>;
  let sources: MemorySource[];
  if (action === "search") {
    const result = await searchNotebookMemory(projectId, raw);
    const hits = result.hits.map(compactHit);
    payload = { rules: MEMORY_RULES, ...result, hits, omittedHits: 0 };
    while (Buffer.byteLength(JSON.stringify(payload)) > MEMORY_TOOL_BYTES && hits.length) { hits.pop(); payload.omittedHits = Number(payload.omittedHits) + 1; }
    sources = hits.map((h) => h.source);
  } else if (action === "read") {
    const result = await readNotebookMemory(projectId, raw?.source, raw?.expectedDigest as string | undefined);
    let body = result.entry.body?.slice(0, 10000) ?? "";
    let code = result.entry.code?.source.slice(0, 4000) ?? "";
    const base = { rules: MEMORY_RULES, projectId, hit: compactHit(result.hit), changedSinceSearch: result.changedSinceSearch, coverage: result.coverage, truncated: result.truncated };
    payload = { ...base, body, code, bodyTruncated: body.length < (result.entry.body?.length ?? 0), codeTruncated: code.length < (result.entry.code?.source.length ?? 0) };
    while (Buffer.byteLength(JSON.stringify(payload)) > MEMORY_TOOL_BYTES && (body.length || code.length)) {
      if (body.length >= code.length) body = body.slice(0, Math.floor(body.length / 2)); else code = code.slice(0, Math.floor(code.length / 2));
      payload = { ...base, body, code, bodyTruncated: true, codeTruncated: true };
    }
    sources = [result.hit.source];
  } else throw new NotebookMemoryError(400, "INVALID_ACTION", "action must be search or read");
  if (Buffer.byteLength(JSON.stringify(payload)) > MEMORY_TOOL_BYTES) {
    payload = { rules: MEMORY_RULES, warning: "Recall metadata exceeded the response budget; use a narrower query/source.", sources, truncated: true };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: { memory: true, sources } };
}
