/** Fresh, bounded research-memory corpus. No embeddings, model calls, persistent
 * truth cache or recursive sandbox scan. Only notebook journals and user notes. */
import fs, { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import { jsonDigest } from "../canonical-json.ts";
import type { NotebookEntry } from "./notebook-store.ts";
import { normalizeNextExperiments, nextExperimentsText } from "../../../web/src/lib/next-experiments.ts";
import { normalizeEvidenceLinks } from "../../../web/src/lib/notebook-evidence-core.ts";
import { planDirectory, validateAnalysisPlanRecords } from "./notebook-plans.ts";
import { planHistoryText, type FrozenPlanEvent } from "../../../web/src/lib/notebook-plans.ts";
import { memorySourceKey, type MemoryCoverage, type MemoryKind, type MemorySource } from "../../../web/src/lib/notebook-memory.ts";

export const MEMORY_SCAN_BYTES = 32 * 1024 * 1024;
export const MEMORY_FILE_BYTES = 4 * 1024 * 1024;
export const MEMORY_ROW_BYTES = 512 * 1024;
export const MEMORY_RECORDS = 5000;
export const MEMORY_FILES = 512;
export const MEMORY_SESSIONS = 100;
export interface MemoryDocument {
  source: MemorySource;
  digest: string;
  entry: NotebookEntry;
  type: MemoryKind;
  historical?: boolean;
  supersededBy?: MemorySource;
  qualifiers: string[];
  /** Opt-in package/planning-history capture only; never returned by recall tools or planning-model prompts. */
  original?: { json: string; entry: NotebookEntry };
}
export interface MemoryCorpus { documents: MemoryDocument[]; coverage: MemoryCoverage }
export function memoryWarning(coverage: MemoryCoverage, message: string): void {
  coverage.complete = false;
  if (coverage.warnings.length < 20 && !coverage.warnings.includes(message)) coverage.warnings.push(message);
}

/** Reject private-directory symlink escapes before reading any source bytes. */
async function safeMemoryPath(projectId: string, file: string): Promise<string> {
  const root = resolvePaths(projectId).sandbox;
  const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
  if (!isWithin(realRoot, realFile) || (await fs.promises.lstat(file)).isSymbolicLink()) throw new Error("Memory source is an unsafe symlink");
  return realFile;
}
async function readSourceFile(projectId: string, file: string, cap: number, tail: boolean, coverage: MemoryCoverage): Promise<Buffer | undefined> {
  if (coverage.scannedFiles >= MEMORY_FILES || coverage.scannedBytes >= MEMORY_SCAN_BYTES) { memoryWarning(coverage, "Project memory scan budget reached; absence of results is not verified."); return; }
  coverage.scannedFiles++;
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    const real = await safeMemoryPath(projectId, file);
    if (!(await fs.promises.stat(real)).isFile()) throw new Error("Source is not a regular file");
    handle = await fs.promises.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Source is not a regular file");
    const available = Math.min(cap, MEMORY_SCAN_BYTES - coverage.scannedBytes);
    if (!tail && before.size > available) { memoryWarning(coverage, "Oversized source/journal omitted from the bounded memory scan."); return; }
    const size = Math.min(before.size, available);
    const offset = before.size - size;
    if (offset > 0) memoryWarning(coverage, "Only the recent tail of a large notebook was scanned; older records and links may be missing.");
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = (await handle.read(bytes, read, size - read, offset + read)).bytesRead;
      if (!n) break;
      read += n;
    }
    coverage.scannedBytes += read;
    const after = await handle.stat(); const current = await fs.promises.stat(file);
    if (read !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) memoryWarning(coverage, "A source changed while memory was being read; refresh before relying on its relationships.");
    let result = bytes.subarray(0, read);
    if (offset > 0) { const first = result.indexOf(10); result = first >= 0 ? result.subarray(first + 1) : Buffer.alloc(0); }
    return result;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") memoryWarning(coverage, "A notebook, user-note sidecar or plan journal was unreadable/unsafe.");
    else memoryWarning(coverage, "A memory source disappeared during the scan.");
    return;
  } finally { await handle?.close(); }
}
const string = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;
const strings = (value: unknown, count: number, length: number) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, count).map((v) => v.slice(0, length)) : undefined;
const entryLink = (v: unknown) => typeof v === "string" && v.trim() && v.length <= 500 && !v.includes("\0") ? v : undefined;
export function memoryEntry(value: unknown): NotebookEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id.trim() || v.id.length > 500 || v.id.includes("\0") || typeof v.timestamp !== "number" || !Number.isFinite(new Date(v.timestamp).getTime()) || typeof v.title !== "string") return;
  const type = ["hypothesis", "method", "observation", "decision", "note"].includes(String(v.type)) ? v.type as NotebookEntry["type"] : "note";
  const code = v.code && typeof v.code === "object" ? v.code as Record<string, unknown> : undefined;
  let nextExperiments;
  if (v.nextExperiments) { try { nextExperiments = normalizeNextExperiments(v.nextExperiments); } catch { /* still marked proposal-only below */ } }
  const proposalOnly = v.nextExperiments !== undefined || v.nextExperimentDecision !== undefined || v.proposalOnly === true;
  const narrative = [typeof v.body === "string" ? v.body : "", nextExperiments ? nextExperimentsText(nextExperiments) : ""].filter(Boolean).join("\n\n");
  const snapshots = Array.isArray(v.artifactSnapshots) ? v.artifactSnapshots.filter((s) => s && typeof s.path === "string" && typeof s.sha256 === "string" && /^[a-f0-9]{64}$/.test(s.sha256) && ["entry", "output", "harvest"].includes(s.timing)).slice(0, 25) : undefined;
  return { id: v.id, type, title: v.title.slice(0, 2000), timestamp: v.timestamp, role: string(v.role, 100) ?? "unknown",
    ...(proposalOnly ? { proposalOnly: true } : {}), ...(nextExperiments ? { nextExperiments } : {}),
    body: narrative ? narrative.slice(0, 64000) : undefined, code: typeof code?.source === "string" ? { source: code.source.slice(0, 32000), lang: string(code.lang, 40) } : undefined,
    artifacts: Array.isArray(v.artifacts) ? v.artifacts.filter((p): p is string => typeof p === "string" && p.length <= 1000 && !p.includes("\0")).slice(0, 100) : undefined, tags: strings(v.tags, 32, 100), limitations: strings(v.limitations, 16, 2000),
    scope: string(v.scope, 2000)?.trim() || undefined, revisitWhen: string(v.revisitWhen, 2000)?.trim() || undefined,
    evidence: normalizeEvidenceLinks(v.evidence), relatesTo: entryLink(v.relatesTo), supersedes: entryLink(v.supersedes),
    stance: ["supports", "refutes", "neutral"].includes(String(v.stance)) ? v.stance as NotebookEntry["stance"] : undefined,
    outcome: ["signal", "null", "inconclusive", "technical-failure"].includes(String(v.outcome)) ? v.outcome as NotebookEntry["outcome"] : undefined,
    confidence: ["low", "medium", "high"].includes(String(v.confidence)) ? v.confidence as NotebookEntry["confidence"] : undefined,
    ...(snapshots ? { artifactSnapshots: snapshots } : {}),
  };
}

export async function loadMemoryCorpus(projectId: string, target?: MemorySource, options: { retainOriginal?: boolean } = {}): Promise<MemoryCorpus> {
  const coverage: MemoryCoverage = { complete: true, scannedFiles: 0, scannedBytes: 0, indexedRecords: 0, skippedRecords: 0, warnings: [] };
  const documents: MemoryDocument[] = [];
  const dir = resolvePaths(projectId).notebookDir;
  let files: string[];
  try {
    const real = await fs.promises.realpath(dir);
    if (!isWithin(await fs.promises.realpath(resolvePaths(projectId).sandbox), real)) throw new Error("Unsafe notebook directory");
    files = await fs.promises.readdir(real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") memoryWarning(coverage, "Notebook directory is unreadable or outside this project.");
    return { documents, coverage };
  }
  const names = new Set<string>();
  for (const file of files.slice(0, 10000)) {
    const sid = file.endsWith(".jsonl") ? file.slice(0, -6) : file.endsWith(".annotations.json") ? file.slice(0, -17) : "";
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sid)) names.add(sid);
  }
  if (files.length > 10000) memoryWarning(coverage, "Notebook directory enumeration was bounded; some sources may be omitted.");
  // Recent sessions first. Stat metadata is ordering only, never proof of unchanged content.
  const sessions: { id: string; time: number }[] = [];
  for (const sid of [...names].slice(0, 1000)) {
    let time = 0;
    for (const name of [`${sid}.jsonl`, `${sid}.annotations.json`]) if (files.includes(name)) {
      try { time = Math.max(time, (await fs.promises.lstat(path.join(dir, name))).mtimeMs); } catch { memoryWarning(coverage, "A source disappeared during discovery."); }
    }
    sessions.push({ id: sid, time });
  }
  if (names.size > 1000 || sessions.length > MEMORY_SESSIONS) memoryWarning(coverage, "Session limit reached; not all project chats were scanned.");
  sessions.sort((a, b) => (a.id === target?.sessionId ? -1 : b.id === target?.sessionId ? 1 : b.time - a.time || a.id.localeCompare(b.id)));
  const add = (document: MemoryDocument) => {
    if (documents.length >= MEMORY_RECORDS) { coverage.skippedRecords++; memoryWarning(coverage, "Record limit reached; not all records/links are represented."); return; }
    documents.push(document);
  };
  for (const { id: sessionId } of sessions.slice(0, MEMORY_SESSIONS)) {
    if (coverage.scannedBytes >= MEMORY_SCAN_BYTES || documents.length >= MEMORY_RECORDS) { memoryWarning(coverage, "Project scan limit reached."); break; }
    const journal = `${sessionId}.jsonl`;
    if (files.includes(journal)) {
      const bytes = await readSourceFile(projectId, path.join(dir, journal), target?.kind === "notebook" && target.sessionId === sessionId ? 16 * 1024 * 1024 : MEMORY_FILE_BYTES, true, coverage);
      if (bytes) {
        const last = bytes.lastIndexOf(10);
        if (last !== bytes.length - 1) memoryWarning(coverage, "An unterminated notebook row was omitted; it may still be being written.");
        let text: string;
        try { text = last >= 0 ? new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, last)) : ""; }
        catch { memoryWarning(coverage, "Invalid UTF-8 notebook data was not silently rewritten into recalled text."); continue; }
        const lines = text.split("\n");
        const selected: MemoryDocument[] = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]; if (!line.trim()) continue;
          if (documents.length + selected.length >= MEMORY_RECORDS) { memoryWarning(coverage, "Record limit reached; older records may be omitted."); break; }
          try {
            if (Buffer.byteLength(line) > MEMORY_ROW_BYTES) throw new Error("oversized");
            const raw = JSON.parse(line); const entry = memoryEntry(raw); if (!entry) throw new Error("invalid");
            const qualifiers: string[] = [];
            if (entry.proposalOnly) qualifiers.push("Next-investigation proposal or planning preference, not an observation, performed method or execution/spending approval.");
            if (entry.nextExperiments && entry.body?.length === 64000) qualifiers.push("Rendered proposal text exceeds this recall view; inspect the original structured notebook record.");
            if (typeof raw.body === "string" && raw.body.length > 64000 || typeof raw.code?.source === "string" && raw.code.source.length > 32000) qualifiers.push("Original narrative/code exceeds this recall view; inspect the original notebook for the full record.");
            if (entry.body && entry.body.length > 16000 || entry.code && entry.code.source.length > 4000) qualifiers.push("Search indexed only the bounded text prefix of this long record.");
            if (raw.title.length > 2000 || Array.isArray(raw.limitations) && raw.limitations.some((s: unknown) => typeof s === "string" && s.length > 2000)) qualifiers.push("Some source text metadata was bounded; inspect the original record for unabridged context.");
            if (raw.type !== entry.type) qualifiers.push("Unrecognized record type is displayed as a note.");
            if (Array.isArray(raw.evidence) && raw.evidence.length !== entry.evidence?.length || Array.isArray(raw.artifacts) && raw.artifacts.length !== entry.artifacts?.length || raw.relatesTo && !entry.relatesTo || raw.supersedes && !entry.supersedes) memoryWarning(coverage, "Invalid/oversized source references were omitted rather than truncated into different ids or paths.");
            selected.push({ source: { kind: "notebook", sessionId, entryId: entry.id }, entry, type: entry.type, digest: crypto.createHash("sha256").update(line).digest("hex"), qualifiers, ...(options.retainOriginal ? { original: { json: line, entry: raw as NotebookEntry } } : {}) });
          } catch { coverage.skippedRecords++; memoryWarning(coverage, "Malformed or oversized notebook rows were skipped; absence of evidence is not verified."); }
        }
        for (const record of selected.reverse()) add(record);
      }
    }
    const annotations = `${sessionId}.annotations.json`;
    if (files.includes(annotations)) {
      const bytes = await readSourceFile(projectId, path.join(dir, annotations), 1024 * 1024, false, coverage);
      if (bytes) try {
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (data.version !== 1 || !Array.isArray(data.annotations)) throw new Error("invalid sidecar");
        for (const note of data.annotations) {
          if (note?.kind !== "note") continue; // pins/comments are annotations, not standalone findings
          if (typeof note.id !== "string" || !note.id.trim() || note.id.length > 500 || typeof note.body !== "string" || note.id.includes("\0") || (note.title !== undefined && typeof note.title !== "string") || typeof note.createdAt !== "number" || !Number.isFinite(new Date(note.createdAt).getTime())) throw new Error("invalid user note");
          const source: MemorySource = { kind: "user-note", sessionId, entryId: note.id };
          add({ source, type: "user-note", digest: jsonDigest({ id: note.id, title: note.title, body: note.body, createdAt: note.createdAt }),
            entry: { id: note.id, type: "note", title: string(note.title, 2000) || "User note", body: note.body.slice(0, 64000), timestamp: note.createdAt, role: "you" },
            qualifiers: ["User-editable note; not an independently verified finding.", ...(note.body.length > 16000 ? ["Only a bounded text prefix was indexed."] : [])] });
        }
      } catch { memoryWarning(coverage, "A user-note sidecar was malformed; its record coverage is incomplete."); }
    }
  }
  // Formal decisions/deviations are also memory. Reuse the journal's validator,
  // but read asynchronously within the same global file/byte budget.
  const hypotheses = documents.filter((d) => d.source.kind === "notebook" && d.entry.type === "hypothesis");
  hypotheses.sort((a, b) => (a.source.entryId === target?.entryId && a.source.sessionId === target?.sessionId ? -1 : b.entry.timestamp - a.entry.timestamp));
  for (const document of hypotheses.slice(0, 64)) {
    const source = { sessionId: document.source.sessionId, entryId: document.source.entryId };
    let names: string[]; let planDir: string;
    try { planDir = planDirectory(projectId, source); names = (await fs.promises.readdir(planDir)).filter((f) => /^\d{6}\.json$/.test(f)).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") memoryWarning(coverage, "A plan journal was unsafe or unreadable."); continue; }
    const records: { name: string; value: unknown }[] = []; let bytesRead = 0; let complete = true;
    for (const name of names) {
      if (bytesRead >= 1024 * 1024 || records.length >= 256) { complete = false; break; }
      const bytes = await readSourceFile(projectId, path.join(planDir, name), Math.min(128 * 1024, 1024 * 1024 - bytesRead), false, coverage);
      if (!bytes) { complete = false; break; }
      bytesRead += bytes.length;
      try { records.push({ name, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }); } catch { complete = false; break; }
    }
    if (!complete) { memoryWarning(coverage, "A plan journal exceeded the recall budget or was incomplete; its events were not inferred."); continue; }
    try {
      const after = (await fs.promises.readdir(planDir)).filter((f) => /^\d{6}\.json$/.test(f)).sort();
      if (JSON.stringify(after) !== JSON.stringify(names)) memoryWarning(coverage, "A plan journal changed while being recalled; refresh its history before reuse.");
      const history = validateAnalysisPlanRecords(source, records);
      const latest = history.events.filter((e): e is FrozenPlanEvent => e.kind === "freeze").at(-1);
      for (const event of history.events) {
        const plan = event.kind === "freeze" ? event : history.events.find((e): e is FrozenPlanEvent => e.kind === "freeze" && e.id === event.planId)!;
        const correction = history.events.find((e) => e.kind === "deviation" && e.corrects === event.id);
        add({ source: { kind: "plan-event", ...source, eventId: event.id }, digest: event.digest, type: event.kind === "freeze" ? "plan" : "deviation",
          historical: event.kind === "freeze" && event.id !== latest?.id,
          ...(correction ? { supersededBy: { kind: "plan-event" as const, ...source, eventId: correction.id } } : {}),
          entry: { id: event.id, type: "note", title: event.kind === "freeze" ? `Frozen plan r${event.revision}: ${document.entry.title}` : `Deviation (${event.field}): ${document.entry.title}`, timestamp: event.recordedAt, role: "you", body: planHistoryText({ source, head: history.head, events: [event] }),
            scope: `Plan revision ${plan.revision}; ${plan.plan.datasets.join(", ")}`, artifacts: plan.plan.datasets,
            artifactSnapshots: plan.datasets.map((s) => ({ ...s, timing: "entry" as const })),
          }, qualifiers: event.kind === "freeze" ? ["Plan records intentions, not executed methods or external preregistration."] : ["Actual procedure and decision timing are user-reported, not independently verified.", `Applies to frozen plan revision ${plan.revision}.`] });
      }
    } catch { memoryWarning(coverage, "A plan journal failed integrity validation; no approval/deviation claims were inferred from it."); }
  }
  if (hypotheses.length > 64) memoryWarning(coverage, "Only 64 recent hypothesis plan journals were checked.");
  const byKey = new Map<string, MemoryDocument>(); const duplicates = new Set<string>();
  for (const doc of documents) { const key = memorySourceKey(doc.source); if (byKey.has(key)) duplicates.add(key); else byKey.set(key, doc); }
  if (duplicates.size) memoryWarning(coverage, "Duplicate source ids were omitted as ambiguous; source relationships are incomplete.");
  const unique = [...byKey].filter(([key]) => !duplicates.has(key)).map(([, d]) => d);
  coverage.indexedRecords = unique.length;
  return { documents: unique, coverage };
}
