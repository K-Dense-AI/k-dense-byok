import { describe, it, expect } from "vitest";
import { buildNotebookPrintHtml, escapeHtml } from "./notebook-print";
import type { NotebookEntry } from "./notebook";
import type { NotebookAnnotation } from "./notebook-annotations";

const e = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id,
  type: "note",
  title: `Title ${id}`,
  timestamp: 1000,
  ...over,
});

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("buildNotebookPrintHtml", () => {
  it("renders markdown bodies (bold → <strong>)", () => {
    const html = buildNotebookPrintHtml([e("a", { body: "some **bold** text" })]);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips script tags from bodies via DOMPurify", () => {
    const html = buildNotebookPrintHtml([
      e("a", { body: "before <script>alert(1)</script> after" }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("rewrites sandbox-relative images in body markdown through the raw endpoint", () => {
    const html = buildNotebookPrintHtml([e("a", { body: "![f](figs/plot.png)" })]);
    expect(html).toMatch(/<img src="[^"]*\/sandbox\/raw\?path=figs%2Fplot\.png[^"]*"/);
  });

  it("leaves absolute http and data image urls alone", () => {
    const html = buildNotebookPrintHtml([e("a", { body: "![f](https://x.test/p.png)" })]);
    expect(html).toContain('src="https://x.test/p.png"');
    expect(html).not.toContain("/sandbox/raw?path=https");
  });

  it("renders image artifacts as <figure> with a raw-endpoint src", () => {
    const html = buildNotebookPrintHtml([e("a", { artifacts: ["figures/fig08.png"] })]);
    expect(html).toContain('<figure class="artifact">');
    expect(html).toMatch(/<img src="[^"]*\/sandbox\/raw\?path=figures%2Ffig08\.png/);
    expect(html).toContain("<figcaption>figures/fig08.png</figcaption>");
  });

  it("renders non-image artifacts as links, not figures", () => {
    const html = buildNotebookPrintHtml([e("a", { artifacts: ["scripts/run.py"] })]);
    expect(html).toContain('class="artifact-link"');
    expect(html).not.toContain("<figure");
  });

  it("adds lane headings when a session-scope export has multiple roles", () => {
    const html = buildNotebookPrintHtml([
      e("a", { role: "agent" }),
      e("b", { role: "literature-scout" }),
    ]);
    expect(html).toContain('<h2 class="lane">Kady (lead)</h2>');
    expect(html).toContain('<h2 class="lane">literature-scout</h2>');
    // Lead lane comes first.
    expect(html.indexOf("Kady (lead)")).toBeLessThan(html.indexOf("literature-scout"));
  });

  it("omits lane headings when only one role is present", () => {
    const html = buildNotebookPrintHtml([e("a", { role: "agent" }), e("b", { role: "agent" })]);
    expect(html).not.toContain('<h2 class="lane">');
  });

  it("marks superseded entries and names their successor", () => {
    const html = buildNotebookPrintHtml([
      e("old", { type: "hypothesis", title: "Old idea", timestamp: 1 }),
      e("new", { type: "hypothesis", title: "New idea", timestamp: 2, supersedes: "old" }),
    ]);
    expect(html).toContain('class="entry superseded"');
    expect(html).toContain("superseded by: New idea");
    expect(html).toContain("supersedes: Old idea");
  });

  it("renders relatesTo with the stance verb and the target title", () => {
    const supports = buildNotebookPrintHtml([
      e("h", { type: "hypothesis", title: "Six types" }),
      e("o", { relatesTo: "h", stance: "supports" }),
    ]);
    expect(supports).toContain("supports: Six types");
    const refutes = buildNotebookPrintHtml([
      e("h", { type: "hypothesis", title: "Six types" }),
      e("o", { relatesTo: "h", stance: "refutes" }),
    ]);
    expect(refutes).toContain("refutes: Six types");
  });

  it("renders hypothesis status badges, tags, and confidence", () => {
    const html = buildNotebookPrintHtml([
      e("h", { type: "hypothesis", title: "Six types", timestamp: 1 }),
      e("o", { relatesTo: "h", stance: "refutes", timestamp: 2, tags: ["scRNA", "qc"], confidence: "high" }),
    ]);
    expect(html).toContain('badge-refuted">refuted</span>');
    expect(html).toContain("#scRNA");
    expect(html).toContain("#qc");
    expect(html).toContain("confidence: high");
  });

  it("marks pinned entries and renders comments under their entry", () => {
    const annotations: NotebookAnnotation[] = [
      { id: "p1", kind: "pin", entryId: "a", createdAt: 5 },
      { id: "c1", kind: "comment", entryId: "a", body: "check the batch effect", createdAt: 6 },
    ];
    const html = buildNotebookPrintHtml([e("a")], { annotations });
    expect(html).toContain("★ pinned");
    expect(html).toContain("check the batch effect");
    expect(html).toContain('class="comment"');
  });

  it("groups by session with names in project scope", () => {
    const html = buildNotebookPrintHtml(
      [
        e("a", { sessionId: "s1", role: "agent" }),
        e("b", { sessionId: "s2", role: "agent" }),
      ],
      { scope: "project", sessionNames: new Map([["s1", "Alpha chat"]]) },
    );
    expect(html).toContain('<h2 class="lane">Alpha chat</h2>');
    expect(html).toContain('<h2 class="lane">s2</h2>'); // falls back to the id
  });

  it("escapes entry titles", () => {
    const html = buildNotebookPrintHtml([e("a", { title: "<img src=x onerror=alert(1)>" })]);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });
});
