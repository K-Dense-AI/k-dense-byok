import { describe, expect, it } from "vitest";
import { breadcrumbFor, parseOutline } from "./outline";

const DOC = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Some text.
\\subsection{Background}
% \\section{Commented out}
\\begin{figure}
  \\includegraphics{x.png}
  \\caption{A nice plot}
\\end{figure}
\\section*{Methods}
\\begin{table}
  \\caption{Results table}
\\end{table}
\\end{document}
`;

describe("parseOutline", () => {
  it("finds sections with correct lines and depths", () => {
    const items = parseOutline(DOC);
    expect(items).toContainEqual({ kind: "section", title: "Intro", line: 3, depth: 2 });
    expect(items).toContainEqual({ kind: "subsection", title: "Background", line: 5, depth: 3 });
    expect(items).toContainEqual({ kind: "section", title: "Methods", line: 11, depth: 2 });
  });
  it("skips commented lines", () => {
    expect(parseOutline(DOC).find((i) => i.title === "Commented out")).toBeUndefined();
  });
  it("captions name figures and tables", () => {
    const items = parseOutline(DOC);
    expect(items).toContainEqual({ kind: "figure", title: "A nice plot", line: 7, depth: 4 });
    expect(items).toContainEqual({ kind: "table", title: "Results table", line: 12, depth: 3 });
  });
  it("keeps an escaped %% in a section title instead of treating it as a comment", () => {
    const items = parseOutline("\\section{50\\% done}");
    expect(items).toContainEqual({ kind: "section", title: "50\\% done", line: 1, depth: 2 });
  });
});

describe("breadcrumbFor", () => {
  it("returns the enclosing section chain", () => {
    const items = parseOutline(DOC);
    const crumb = breadcrumbFor(items, 6);
    expect(crumb.map((c) => c.title)).toEqual(["Intro", "Background"]);
  });
  it("resets at a new same-level section", () => {
    const items = parseOutline(DOC);
    expect(breadcrumbFor(items, 12).map((c) => c.title)).toEqual(["Methods"]);
  });
});
