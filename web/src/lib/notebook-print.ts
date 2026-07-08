/**
 * Self-contained, print-ready HTML for the notebook's PDF export.
 *
 * Markdown bodies render through a synchronous `marked` pipeline sanitized by
 * DOMPurify — NOT the app's Streamdown pipeline, whose Shiki/mermaid stages
 * are async and would make the popup's print() timing indeterminate. Sandbox-
 * relative images (artifact figures and <img> in bodies) are rewritten through
 * rawFileUrl so they resolve inside the popup.
 */
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { rawFileUrl, fileCategory } from "./use-sandbox";
import type { NotebookEntry } from "./notebook";
import { deriveThreads } from "./notebook-threads";
import { roleLabel } from "./notebook-filters";
import { derive, type NotebookAnnotation } from "./notebook-annotations";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveSrc(href: string): string {
  return /^(https?:|data:)/i.test(href) ? href : rawFileUrl(href.replace(/^\.?\//, ""));
}

function mdToHtml(md: string): string {
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      image({ href, title, text }) {
        const src = escapeHtml(resolveSrc(href));
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${src}" alt="${escapeHtml(text)}"${t} />`;
      },
    },
  });
  return DOMPurify.sanitize(marked.parse(md) as string);
}

const TYPE_LABEL: Record<NotebookEntry["type"], string> = {
  hypothesis: "Hypothesis",
  method: "Method",
  observation: "Observation",
  decision: "Decision",
  note: "Note",
};

export interface NotebookPrintOpts {
  scope?: "session" | "project";
  sessionNames?: ReadonlyMap<string, string>;
  /** Pins + comments; user notes should already be merged as entries. */
  annotations?: NotebookAnnotation[];
}

function entryHtml(
  entry: NotebookEntry,
  ctx: {
    byId: Map<string, NotebookEntry>;
    threads: ReturnType<typeof deriveThreads>;
    pinnedIds: Set<string>;
    commentsByEntry: Map<string, NotebookAnnotation[]>;
    showRole: boolean;
  },
): string {
  const thread = ctx.threads.get(entry.id);
  const superseded = Boolean(thread?.supersededBy);
  const meta: string[] = [
    `<span class="entry-type">${escapeHtml(TYPE_LABEL[entry.type] ?? entry.type)}</span>`,
  ];
  if (ctx.showRole) meta.push(`<span>by ${escapeHtml(roleLabel(entry.role ?? "agent"))}</span>`);
  if (entry.confidence) meta.push(`<span>confidence: ${escapeHtml(entry.confidence)}</span>`);
  meta.push(`<span class="entry-time">${escapeHtml(new Date(entry.timestamp).toLocaleString())}</span>`);

  const badges: string[] = [];
  if (entry.type === "hypothesis" && thread?.status) {
    badges.push(`<span class="badge badge-${thread.status}">${thread.status}</span>`);
  }
  if (ctx.pinnedIds.has(entry.id)) badges.push(`<span class="badge badge-pin">★ pinned</span>`);

  const threadLines: string[] = [];
  if (entry.relatesTo) {
    const target = ctx.byId.get(entry.relatesTo);
    const rel =
      entry.stance === "supports" ? "supports" : entry.stance === "refutes" ? "refutes" : "relates to";
    threadLines.push(`<div class="thread">↳ ${rel}: ${escapeHtml(target?.title ?? entry.relatesTo)}</div>`);
  }
  if (entry.supersedes) {
    const target = ctx.byId.get(entry.supersedes);
    threadLines.push(`<div class="thread">↺ supersedes: ${escapeHtml(target?.title ?? entry.supersedes)}</div>`);
  }
  if (thread?.supersededBy) {
    const by = ctx.byId.get(thread.supersededBy);
    threadLines.push(`<div class="thread superseded-note">⚠ superseded by: ${escapeHtml(by?.title ?? thread.supersededBy)}</div>`);
  }

  const tags = entry.tags?.length
    ? `<div class="tags">${entry.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join(" ")}</div>`
    : "";
  const body = entry.body ? `<div class="body">${mdToHtml(entry.body)}</div>` : "";
  const code = entry.code
    ? `<pre class="code"><code>${escapeHtml(entry.code.source)}</code></pre>`
    : "";
  const artifacts = (entry.artifacts ?? [])
    .map((p) => {
      const url = escapeHtml(rawFileUrl(p));
      if (fileCategory(p) === "image") {
        return `<figure class="artifact"><img src="${url}" alt="${escapeHtml(p)}" /><figcaption>${escapeHtml(p)}</figcaption></figure>`;
      }
      return `<div class="artifact-link"><a href="${url}">${escapeHtml(p)}</a></div>`;
    })
    .join("\n");
  const comments = (ctx.commentsByEntry.get(entry.id) ?? [])
    .map(
      (c) =>
        `<div class="comment"><span class="comment-author">You</span> <span class="entry-time">${escapeHtml(new Date(c.createdAt).toLocaleString())}</span><div>${mdToHtml(c.body ?? "")}</div></div>`,
    )
    .join("\n");

  return `
    <section class="entry${superseded ? " superseded" : ""}">
      <div class="entry-meta">${meta.join(" · ")}</div>
      <h3 class="entry-title">${escapeHtml(entry.title)}${badges.length ? " " + badges.join(" ") : ""}</h3>
      ${threadLines.join("\n")}
      ${tags}
      ${body}
      ${code}
      ${artifacts}
      ${comments}
    </section>
  `;
}

export function buildNotebookPrintHtml(
  entries: NotebookEntry[],
  opts: NotebookPrintOpts = {},
): string {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const threads = deriveThreads(entries);
  const { pinnedIds, commentsByEntry } = derive({
    version: 1,
    annotations: opts.annotations ?? [],
  });

  let sectionsHtml: string;
  if (opts.scope === "project") {
    // One section per session, entries in given (chronological) order.
    const order: string[] = [];
    const bySession = new Map<string, NotebookEntry[]>();
    for (const e of entries) {
      const sid = e.sessionId ?? "";
      if (!bySession.has(sid)) {
        bySession.set(sid, []);
        order.push(sid);
      }
      bySession.get(sid)!.push(e);
    }
    sectionsHtml = order
      .map((sid) => {
        const name = opts.sessionNames?.get(sid) ?? sid;
        const inner = bySession
          .get(sid)!
          .map((e) => entryHtml(e, { byId, threads, pinnedIds, commentsByEntry, showRole: true }))
          .join("\n");
        return `<h2 class="lane">${escapeHtml(name)}</h2>\n${inner}`;
      })
      .join("\n");
  } else {
    // One section per agent lane: lead first, then by first appearance.
    const order: string[] = [];
    const byRole = new Map<string, NotebookEntry[]>();
    for (const e of entries) {
      const role = e.role ?? "agent";
      if (!byRole.has(role)) {
        byRole.set(role, []);
        order.push(role);
      }
      byRole.get(role)!.push(e);
    }
    order.sort((a, b) => (a === "agent" ? -1 : b === "agent" ? 1 : 0));
    const multiLane = order.length > 1;
    sectionsHtml = order
      .map((role) => {
        const inner = byRole
          .get(role)!
          .map((e) =>
            entryHtml(e, { byId, threads, pinnedIds, commentsByEntry, showRole: !multiLane }),
          )
          .join("\n");
        return multiLane ? `<h2 class="lane">${escapeHtml(roleLabel(role))}</h2>\n${inner}` : inner;
      })
      .join("\n");
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Lab Notebook</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; margin: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  h2.lane { font-size: 1.1rem; margin: 1.5rem 0 0.25rem; padding-bottom: 0.25rem; border-bottom: 2px solid #ddd; }
  .entry { break-inside: avoid; page-break-inside: avoid; border-top: 1px solid #ddd; padding: 1rem 0; }
  .entry:first-of-type { border-top: none; }
  .entry.superseded { opacity: 0.6; }
  .entry.superseded .entry-title { text-decoration: line-through; }
  .entry-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #555; }
  .entry-time { margin-left: auto; text-transform: none; }
  .entry-title { font-size: 1.05rem; margin: 0.25rem 0 0.5rem; }
  .badge { font-size: 0.65rem; border: 1px solid #ccc; border-radius: 999px; padding: 0.1rem 0.5rem; vertical-align: middle; text-transform: uppercase; }
  .badge-supported { color: #047857; border-color: #047857; }
  .badge-refuted { color: #be123c; border-color: #be123c; }
  .badge-open { color: #555; }
  .badge-pin { color: #b45309; border-color: #b45309; }
  .thread { font-size: 0.8rem; color: #555; margin: 0.1rem 0; }
  .superseded-note { color: #be123c; }
  .tags { margin: 0.25rem 0; }
  .tag { font-size: 0.7rem; color: #555; border: 1px solid #ddd; border-radius: 999px; padding: 0.05rem 0.45rem; margin-right: 0.25rem; }
  .body { font-size: 0.9rem; }
  .body p { margin: 0.4rem 0; }
  .body table { border-collapse: collapse; }
  .body th, .body td { border: 1px solid #ddd; padding: 0.25rem 0.5rem; font-size: 0.85rem; }
  .body img { max-width: 100%; }
  .code { background: #f4f4f4; border-radius: 4px; padding: 0.6rem; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; }
  .artifact img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .artifact figcaption { font-size: 0.75rem; color: #666; margin-top: 0.25rem; }
  .artifact-link { font-size: 0.85rem; }
  .comment { border-left: 3px solid #f59e0b; padding-left: 0.5rem; margin: 0.5rem 0; font-size: 0.85rem; }
  .comment-author { font-weight: 600; color: #b45309; }
  @media print {
    body { margin: 0.5in; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <h1>Lab Notebook</h1>
  <div class="subtitle">Exported ${escapeHtml(new Date().toLocaleString())}</div>
  ${sectionsHtml}
</body>
</html>`;
}
