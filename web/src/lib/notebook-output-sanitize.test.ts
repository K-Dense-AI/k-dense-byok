import { describe, expect, it } from "vitest";
import { sanitizeNotebookHtml, sanitizeNotebookSvg } from "./notebook-output-sanitize";

describe("notebook output sanitizer", () => {
  it("keeps a pandas-style table but strips scripts and handlers", () => {
    const out = sanitizeNotebookHtml(
      '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>' +
        '<script>fetch("/sessions")</script>' +
        '<img src=x onerror="fetch(\'/sessions\')">' +
        '<a href="javascript:alert(1)">x</a>',
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("javascript:");
  });

  it("keeps SVG drawing elements but strips script, handlers and foreignObject", () => {
    const out = sanitizeNotebookSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onload="x()"/>' +
        '<script>x()</script><foreignObject><body onload="x()"/></foreignObject></svg>',
    );
    expect(out).toContain("<rect");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onload");
    expect(out).not.toContain("foreignObject");
  });
});

describe("isolated notebook outputs", () => {
  it("turns SVG into a well-formed image data URL, adding missing namespaces", async () => {
    const { notebookSvgDataUrl } = await import("./notebook-output-sanitize");
    const url = notebookSvgDataUrl(
      '<?xml version="1.0"?>\n<svg width="10pt" height="10pt"><defs><path id="g" d="M0 0"/></defs><use xlink:href="#g"/><style>*{stroke-linejoin:round}</style></svg>',
    );
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const markup = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
  });

  it("wraps HTML in a document that blocks every network load", async () => {
    const { notebookHtmlDocument } = await import("./notebook-output-sanitize");
    const doc = notebookHtmlDocument("<table><tr><td>1</td></tr></table>", false);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<td>1</td>");
  });
});
