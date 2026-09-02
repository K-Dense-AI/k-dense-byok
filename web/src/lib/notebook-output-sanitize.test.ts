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
