/**
 * Render notebook entries to a Markdown lab record: a header, then one section
 * per entry with type label, title, attribution, thread links, body, embedded
 * image artifacts (other files as links), and fenced code. Elapsed is derived
 * from the first entry. Pure (no fs) — zip bundling passes artifactHref /
 * missingArtifacts to rewrite or annotate artifact references.
 */
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";
import { deriveEvidenceThreads, evidenceLinks, notebookEntryKey, notebookTargetKey, HYPOTHESIS_LABELS } from "../../../web/src/lib/notebook-evidence-core.ts";
import type { NotebookAnnotation } from "./notebook-annotations.ts";
import { nextExperimentsText } from "../../../web/src/lib/next-experiments.ts";
import { planHistoryText } from "../../../web/src/lib/notebook-plans.ts";
import { resultReferenceText } from "../../../web/src/lib/notebook-result-links.ts";

const LABEL: Record<NotebookEntryType, string> = {
  hypothesis: "Hypothesis",
  method: "Method",
  observation: "Observation",
  decision: "Decision",
  note: "Note",
};

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

/** Entry carrying the project-scope `sessionId` stamp the merge route adds. */
type ScopedEntry = NotebookEntry & { sessionId?: string };

export interface NotebookMarkdownOpts {
  /** Session-scope export: the session's id. Omit for a project-scope export. */
  sessionId?: string;
  projectName?: string;
  /**
   * Project-scope export: session id → display label. When present, entries
   * are grouped under a heading per session (mirroring the "All chats" view
   * and its PDF export) and entry headings drop a level.
   */
  sessionLabels?: ReadonlyMap<string, string>;
  /** Optional user layer included by complete-project exports. */
  annotations?: readonly NotebookAnnotation[];
  /** Rewrite an artifact link target (e.g. into a zip bundle); undefined keeps the path. */
  artifactHref?: (relPath: string) => string | undefined;
  /** Artifact paths known missing on disk — noted as text instead of linked. */
  missingArtifacts?: ReadonlySet<string>;
}

function annotationTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

export function notebookToMarkdown(
  entries: NotebookEntry[],
  opts: NotebookMarkdownOpts,
): string {
  const grouped = opts.sessionLabels !== undefined;
  const h = grouped ? "###" : "##";
  const lines: string[] = [];
  lines.push(`# Lab Notebook`);
  if (opts.projectName) lines.push(`**Project:** ${opts.projectName}`);
  if (opts.sessionId) lines.push(`**Session:** ${opts.sessionId}`);
  if (grouped) {
    const chats = new Set(entries.map((e) => (e as ScopedEntry).sessionId ?? ""));
    lines.push(`**Chats:** ${chats.size}`);
  }
  if (entries.length > 0) {
    const start = new Date(entries[0].timestamp).toISOString();
    const end = new Date(entries[entries.length - 1].timestamp).toISOString();
    lines.push(`**Span:** ${start} → ${end}`);
    lines.push(`**Entries:** ${entries.length}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  const byId = new Map(entries.map((e) => [notebookEntryKey(e as ScopedEntry), e]));
  const threads = deriveEvidenceThreads(entries);
  const annotationsByEntry = new Map<string, NotebookAnnotation[]>();
  const notes: NotebookAnnotation[] = [];
  const unresolved: NotebookAnnotation[] = [];
  for (const annotation of opts.annotations ?? []) {
    if (annotation.kind === "note") {
      notes.push(annotation);
    } else if (annotation.entryId && byId.has(notebookEntryKey({ id: annotation.entryId, sessionId: (annotation as { sessionId?: string }).sessionId }))) {
      const key = notebookEntryKey({ id: annotation.entryId, sessionId: (annotation as { sessionId?: string }).sessionId });
      const annotations = annotationsByEntry.get(key) ?? [];
      annotations.push(annotation);
      annotationsByEntry.set(key, annotations);
    } else {
      unresolved.push(annotation);
    }
  }

  const t0 = entries[0]?.timestamp ?? 0;
  let openSession: string | undefined;
  for (const e of entries) {
    if (grouped) {
      // Entries arrive chronologically with a sessionId stamp; start a new
      // section whenever the chat changes (same grouping as the PDF export).
      const sid = (e as ScopedEntry).sessionId ?? "";
      if (sid !== openSession) {
        openSession = sid;
        lines.push(`## ${opts.sessionLabels?.get(sid) || sid || "Unattributed"}`, "");
      }
    }
    const elapsed = Math.max(0, Math.round((e.timestamp - t0) / 1000));
    lines.push(`${h} ${LABEL[e.type]}: ${e.title}`);
    const bits = [`+${elapsed}s`, `by ${e.role}`];
    if (e.confidence) bits.push(`author confidence: ${e.confidence} (self-reported)`);
    if (e.tags?.length) bits.push(e.tags.map((t) => `#${t}`).join(" "));
    lines.push(`_${bits.join(" · ")}_`);
    const thread = threads.get(notebookEntryKey(e as ScopedEntry));
    if (thread?.status) lines.push(`**Evidence status:** ${HYPOTHESIS_LABELS[thread.status]} (authored interpretations, not a scientific verdict)`);
    if (thread?.reviewRequired) lines.push("**Needs review:** direct artifacts in this entry or its linked evidence changed or are missing. This does not refute the claim.");
    for (const link of evidenceLinks(e)) {
      const target = byId.get(notebookTargetKey(e as ScopedEntry, link.entryId, link.sessionId));
      const rel = link.relation === "challenges" ? "refutes / challenges" : link.relation === "context" ? "relates to" : link.relation;
      lines.push(`_↳ ${rel} “${target?.title ?? link.entryId}” (${link.entryId})${!target ? " — unavailable in this export" : ""}_`);
      if (link.rationale) lines.push(link.rationale);
    }
    if (e.supersedes) {
      const target = byId.get(notebookTargetKey(e as ScopedEntry, e.supersedes));
      lines.push(`_↺ supersedes “${target?.title ?? e.supersedes}” (${e.supersedes})_`);
    }
    const superseder = thread?.supersededBy ? byId.get(thread.supersededBy) : undefined;
    if (superseder) lines.push(`_⚠ superseded by “${superseder.title}”_`);
    if (e.scope) lines.push(`**Applicability (authored):** ${e.scope}`);
    if (e.revisitWhen) lines.push(`**Revisit when (condition, not an automatic action):** ${e.revisitWhen}`);
    if (e.outcome) lines.push(`**Outcome:** ${e.outcome} (null results and technical failures do not automatically refute a hypothesis)`);
    if (e.limitations?.length) lines.push("**Limitations:**", ...e.limitations.map((x) => `- ${x}`));
    if (e.artifactHealth?.length) {
      lines.push("**Artifact checks:** direct cited files only; unchanged bytes do not verify scientific validity or upstream inputs.");
      for (const check of e.artifactHealth) lines.push(`- \`${check.path}\`: **${check.status}** — ${check.reason ?? ""} (checked ${annotationTime(check.checkedAt)})`);
    }
    if (e.artifactHealthTruncated) lines.push(`**Incomplete checks:** ${e.artifactHealthTruncated} additional artifacts were not checked.`);
    const entryAnnotations = annotationsByEntry.get(notebookEntryKey(e as ScopedEntry)) ?? [];
    const pins = entryAnnotations.filter((annotation) => annotation.kind === "pin");
    if (pins.length > 0) {
      const times = pins.map((pin) => annotationTime(pin.createdAt)).join(", ");
      lines.push(`_Pinned by user (${times})_`);
    }
    lines.push("");
    if (e.body) { lines.push(e.body); lines.push(""); }
    if (e.nextExperiments) lines.push("**Proposed next investigations — not performed:**", nextExperimentsText(e.nextExperiments), "");
    if (e.nextExperimentBinding) lines.push("**Recorded proposal context (not scientific verification):**", "```json", JSON.stringify(e.nextExperimentBinding, null, 2), "```", "");
    if (e.nextExperimentDecision) lines.push("**User planning preference — not execution/spending approval:**", "```json", JSON.stringify(e.nextExperimentDecision, null, 2), "```", "");
    if (e.analysisPlan) lines.push("**Proposed analysis plan (draft, not approved):**", "```json", JSON.stringify(e.analysisPlan, null, 2), "```", "");
    if (e.robustness) lines.push("**Proposed robustness workflow (not approved or executed):**", "```json", JSON.stringify(e.robustness, null, 2), "```", "");
    if (e.planHistory) lines.push(planHistoryText(e.planHistory), "");
    if (e.planHistoryError) lines.push(`**Plan history unavailable:** ${e.planHistoryError}`, "");
    if (e.results?.length) {
      lines.push("**Recorded scientific-result references:** source identifiers and pinned content digests, not independently verified measurements. Canonical source session logs are not bundled in this notebook export.");
      for (const ref of e.results) {
        const sid = ref.sessionId ?? (e as ScopedEntry).sessionId ?? opts.sessionId;
        const snapshot = e.resultSnapshots?.find((s) => s.sessionId === sid && s.toolCallId === ref.toolCallId);
        lines.push(`- ${resultReferenceText(snapshot ?? ref, sid)}`);
      }
      lines.push("");
    }
    if (e.code) {
      lines.push("```" + (e.code.lang ?? ""));
      lines.push(e.code.source);
      lines.push("```");
      lines.push("");
    }
    if (e.artifacts?.length) {
      for (const p of e.artifacts) {
        if (opts.missingArtifacts?.has(p)) {
          lines.push(`\`${p}\` _(artifact missing at export time)_`);
          continue;
        }
        const name = p.split("/").pop() ?? p;
        const href = opts.artifactHref?.(p) ?? p;
        lines.push(IMAGE_RE.test(p) ? `![${name}](${href})` : `[${p}](${href})`);
      }
      lines.push("");
    }
    const comments = entryAnnotations.filter((annotation) => annotation.kind === "comment");
    if (comments.length > 0) {
      lines.push(`${h}# User comments`, "");
      for (const comment of comments) {
        lines.push(`**${annotationTime(comment.createdAt)}**`, "", comment.body ?? "", "");
      }
    }
  }
  if (notes.length > 0) {
    lines.push("## User notes", "");
    for (const note of notes) {
      lines.push(`### ${note.title?.trim() || "Note"}`);
      lines.push(`_${annotationTime(note.createdAt)}_`, "", note.body ?? "", "");
    }
  }
  if (unresolved.length > 0) {
    lines.push("## Unresolved annotations", "");
    for (const annotation of unresolved) {
      const target = annotation.entryId ?? "unknown";
      const detail = annotation.kind === "comment" ? `: ${annotation.body ?? ""}` : "";
      lines.push(
        `- ${annotation.kind} for missing entry \`${target}\` (${annotationTime(annotation.createdAt)})${detail}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
