/** Bounded lookup of canonical scientific_result envelopes in persisted Pi logs. */
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import { isWithin, SandboxError } from "../sandbox-fs.ts";
import { isValidSessionId, readNotebookEntries } from "./notebook-store.ts";
import { scientificResultFromDetails, type ScientificResultCard } from "./scientific-result.ts";
import { planDigest } from "./notebook-plans.ts";
import { normalizeResultLinks, type NotebookResultLink, type NotebookResultSnapshot, type NotebookResolvedResult } from "../../../web/src/lib/notebook-result-links.ts";

export const RESULT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_LINE_CHARS = 256 * 1024;
export type Lookup = { status: NotebookResultSnapshot["status"]; card?: ScientificResultCard; sha256?: string; reason?: string };

export async function lookupSessionResults(projectId: string, sessionId: string, ids: string[], budget: { bytes: number }): Promise<Map<string, Lookup>> {
  const all = (status: Lookup["status"], reason: string) => new Map(ids.map((id) => [id, { status, reason }]));
  if (!isValidSessionId(sessionId) || sessionId.length > 200) return all("unverified", "Invalid source session id");
  const root = resolvePaths(projectId).sessionsDir;
  let files: string[];
  try { files = await fs.promises.readdir(root); }
  catch (error) { return all((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified", "Source session log is unavailable"); }
  // Do not reuse findSessionFile's broad suffix match: `abc` must not select
  // another session named `xyzabc`. Ambiguous matches never pick arbitrarily.
  files = files.filter((f) => f === `${sessionId}.jsonl` || f.endsWith(`_${sessionId}.jsonl`));
  if (files.length !== 1) return all(files.length ? "ambiguous" : "missing", "Source session file is missing or ambiguous");
  const file = path.join(root, files[0]);
  try {
    const [realSandbox, realRoot, realFile] = await Promise.all([fs.promises.realpath(resolvePaths(projectId).sandbox), fs.promises.realpath(root), fs.promises.realpath(file)]);
    if (!isWithin(realSandbox, realRoot) || !isWithin(realRoot, realFile)) return all("unverified", "Source session symlink leaves the session directory");
    const before = await fs.promises.stat(realFile);
    if (!before.isFile() || before.size > budget.bytes) return all("unverified", "Session scan budget exceeded; result identity was not verified");
    budget.bytes -= before.size;
    // Retain at most one bounded card per requested id, even if a malformed
    // log repeats that id thousands of times. Differing duplicates set a flag.
    const matches = new Map<string, { card: ScientificResultCard; sha256: string; ambiguous: boolean }>();
    let pending = "";
    let skipping = false;
    let incomplete = false;
    let invalidSession = false;
    const wanted = new Set(ids);
    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        const row = JSON.parse(text);
        if (row.type === "session" && row.id !== sessionId) invalidSession = true;
        const msg = row.message;
        if (row.type !== "message" || msg?.role !== "toolResult" || msg.toolName !== "scientific_result" || msg.isError || !wanted.has(msg.toolCallId)) return;
        const card = scientificResultFromDetails(msg.details);
        if (!card) { incomplete = true; return; }
        const sha256 = planDigest(card);
        const previous = matches.get(msg.toolCallId);
        if (!previous) matches.set(msg.toolCallId, { card, sha256, ambiguous: false });
        else if (previous.sha256 !== sha256) previous.ambiguous = true;
      } catch { incomplete = true; }
    };
    if (before.size > 0) {
      const stream = fs.createReadStream(realFile, { encoding: "utf8", highWaterMark: 64 * 1024, end: before.size - 1 });
      for await (const chunk of stream) {
        const pieces = String(chunk).split("\n");
        for (let i = 0; i < pieces.length; i++) {
          if (!skipping) {
            pending += pieces[i];
            if (pending.length > MAX_LINE_CHARS) { pending = ""; skipping = true; incomplete = true; }
          }
          if (i < pieces.length - 1) { if (!skipping) line(pending); pending = ""; skipping = false; }
        }
      }
      if (pending.trim()) incomplete = true; // append may still be in progress
    }
    const after = await fs.promises.stat(file);
    if (invalidSession || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return all("unverified", "Source log changed or its session identity could not be verified");
    return new Map<string, Lookup>(ids.map((id): [string, Lookup] => {
      const match = matches.get(id);
      if (match?.ambiguous) return [id, { status: "ambiguous", reason: "Multiple different saved results use this tool-call id" }];
      if (incomplete) return [id, {
        status: "unverified", ...(match ? { card: match.card, sha256: match.sha256 } : {}),
        reason: "Source log contains oversized or incomplete rows. Any displayed card was located in a valid saved result, but uniqueness could not be fully verified.",
      }];
      if (!match) return [id, { status: "missing", reason: "No successful persisted scientific_result with this id" }];
      return [id, { status: "available", card: match.card, sha256: match.sha256 }];
    }));
  } catch { return all("unverified", "Source log could not be read safely"); }
}

export async function snapshotNotebookResults(projectId: string, sessionId: string, input: NotebookResultLink[]): Promise<NotebookResultSnapshot[]> {
  const refs = normalizeResultLinks(input).map((r) => ({ ...r, sessionId: r.sessionId ?? sessionId }));
  const budget = { bytes: RESULT_SCAN_BYTES };
  const lookups = new Map<string, Map<string, Lookup>>();
  for (const sid of new Set(refs.map((r) => r.sessionId))) lookups.set(sid, await lookupSessionResults(projectId, sid, refs.filter((r) => r.sessionId === sid).map((r) => r.toolCallId), budget));
  return refs.map((ref) => {
    const result = lookups.get(ref.sessionId)!.get(ref.toolCallId)!;
    return { ...ref, status: result.status, ...(result.status === "available" && result.sha256 ? { sha256: result.sha256 } : {}), ...(result.reason ? { reason: result.reason } : {}) };
  });
}

export async function resolveNotebookResult(projectId: string, sessionId: string, entryId: string, index: number): Promise<NotebookResolvedResult<ScientificResultCard>> {
  if (!isValidSessionId(sessionId) || !Number.isInteger(index) || index < 0 || index >= 12) throw new SandboxError(400, "Invalid notebook result reference");
  const entries = readNotebookEntries(sessionId, projectId).filter((e) => e.id === entryId);
  if (entries.length !== 1) throw new SandboxError(404, "Saved notebook entry not found or ambiguous");
  const entry = entries[0];
  const link = normalizeResultLinks(entry.results, true)[index];
  if (!link) throw new SandboxError(404, "No such result reference");
  const sourceSession = link.sessionId ?? sessionId;
  if (link.childLocal) {
    const reason = "This child-local result is not indexed in the parent session; it cannot be resolved as parent evidence.";
    return { reference: { ...link, sessionId: sourceSession, status: "unverified", reason }, status: "unverified", reason };
  }
  const pinned = entry.resultSnapshots?.find((s) => s.sessionId === sourceSession && s.toolCallId === link.toolCallId);
  const reference: NotebookResultSnapshot = pinned ?? { ...link, sessionId: sourceSession, status: "unverified", reason: "No citation-time result identity was recorded" };
  const result = (await lookupSessionResults(projectId, sourceSession, [link.toolCallId], { bytes: RESULT_SCAN_BYTES })).get(link.toolCallId)!;
  if (reference.sha256 && result.sha256 && reference.sha256 !== result.sha256) return { reference, status: "changed", reason: "The saved result no longer matches the cited identity. The replacement is not displayed as original evidence." };
  if (result.status !== "available") return { reference, status: result.status, reason: result.reason, ...(result.status === "unverified" && result.card ? { card: result.card } : {}) };
  return { reference, status: reference.sha256 ? "available" : "unverified", sha256: result.sha256, card: result.card, reason: reference.sha256 ? "Matches the cited persisted result. Structured output is not independently verified science." : "Showing the currently saved result; its identity at citation time was not pinned." };
}
