/**
 * Render notebook entries to a Markdown lab record: a header, then one section
 * per entry with type label, title, attribution, thread links, body, embedded
 * image artifacts (other files as links), and fenced code. Elapsed is derived
 * from the first entry. Pure (no fs) — zip bundling passes artifactHref /
 * missingArtifacts to rewrite or annotate artifact references.
 */
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";
import type { NotebookAnnotation } from "./notebook-annotations.ts";

const LABEL: Record<NotebookEntryType, string> = {
  hypothesis: "Hypothesis",
  method: "Method",
  observation: "Observation",
  decision: "Decision",
  note: "Note",
};

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

export interface NotebookMarkdownOpts {
  sessionId: string;
  projectName?: string;
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
  const lines: string[] = [];
  lines.push(`# Lab Notebook`);
  if (opts.projectName) lines.push(`**Project:** ${opts.projectName}`);
  lines.push(`**Session:** ${opts.sessionId}`);
  if (entries.length > 0) {
    const start = new Date(entries[0].timestamp).toISOString();
    const end = new Date(entries[entries.length - 1].timestamp).toISOString();
    lines.push(`**Span:** ${start} → ${end}`);
    lines.push(`**Entries:** ${entries.length}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  const byId = new Map(entries.map((e) => [e.id, e]));
  const supersededBy = new Map<string, NotebookEntry>();
  const annotationsByEntry = new Map<string, NotebookAnnotation[]>();
  const notes: NotebookAnnotation[] = [];
  const unresolved: NotebookAnnotation[] = [];
  for (const e of entries) {
    if (e.supersedes) supersededBy.set(e.supersedes, e);
  }
  for (const annotation of opts.annotations ?? []) {
    if (annotation.kind === "note") {
      notes.push(annotation);
    } else if (annotation.entryId && byId.has(annotation.entryId)) {
      const annotations = annotationsByEntry.get(annotation.entryId) ?? [];
      annotations.push(annotation);
      annotationsByEntry.set(annotation.entryId, annotations);
    } else {
      unresolved.push(annotation);
    }
  }

  const t0 = entries[0]?.timestamp ?? 0;
  for (const e of entries) {
    const elapsed = Math.max(0, Math.round((e.timestamp - t0) / 1000));
    lines.push(`## ${LABEL[e.type]}: ${e.title}`);
    const bits = [`+${elapsed}s`, `by ${e.role}`];
    if (e.confidence) bits.push(`confidence: ${e.confidence}`);
    if (e.tags?.length) bits.push(e.tags.map((t) => `#${t}`).join(" "));
    lines.push(`_${bits.join(" · ")}_`);
    if (e.relatesTo) {
      const target = byId.get(e.relatesTo);
      const rel =
        e.stance === "supports" ? "supports" : e.stance === "refutes" ? "refutes" : "relates to";
      lines.push(`_↳ ${rel} “${target?.title ?? e.relatesTo}” (${e.relatesTo})_`);
    }
    if (e.supersedes) {
      const target = byId.get(e.supersedes);
      lines.push(`_↺ supersedes “${target?.title ?? e.supersedes}” (${e.supersedes})_`);
    }
    const superseder = supersededBy.get(e.id);
    if (superseder) lines.push(`_⚠ superseded by “${superseder.title}”_`);
    const entryAnnotations = annotationsByEntry.get(e.id) ?? [];
    const pins = entryAnnotations.filter((annotation) => annotation.kind === "pin");
    if (pins.length > 0) {
      const times = pins.map((pin) => annotationTime(pin.createdAt)).join(", ");
      lines.push(`_Pinned by user (${times})_`);
    }
    lines.push("");
    if (e.body) { lines.push(e.body); lines.push(""); }
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
      lines.push("### User comments", "");
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
