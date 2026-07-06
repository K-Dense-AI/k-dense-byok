/**
 * Render notebook entries to a Markdown lab record: a header, then one section
 * per entry with type label, title, body, embedded image artifacts (other
 * files as links), and fenced code. Elapsed is derived from the first entry.
 */
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";

const LABEL: Record<NotebookEntryType, string> = {
  hypothesis: "Hypothesis",
  method: "Method",
  observation: "Observation",
  decision: "Decision",
  note: "Note",
};

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

export function notebookToMarkdown(
  entries: NotebookEntry[],
  opts: { sessionId: string; projectName?: string },
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

  const t0 = entries[0]?.timestamp ?? 0;
  for (const e of entries) {
    const elapsed = Math.max(0, Math.round((e.timestamp - t0) / 1000));
    lines.push(`## ${LABEL[e.type]}: ${e.title}`);
    const bits = [`+${elapsed}s`];
    if (e.confidence) bits.push(`confidence: ${e.confidence}`);
    if (e.tags?.length) bits.push(e.tags.map((t) => `#${t}`).join(" "));
    lines.push(`_${bits.join(" · ")}_`);
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
        const name = p.split("/").pop() ?? p;
        lines.push(IMAGE_RE.test(p) ? `![${name}](${p})` : `[${p}](${p})`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
