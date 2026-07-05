import { describe, expect, it } from "vitest";
import { parseCompileDiagnostics } from "./diagnostics";

const FILE_LINE_LOG = `This is pdfTeX
./main.tex:12: Undefined control sequence.
l.12 \\badmacro
./other.tex:3: Missing $ inserted.
./main.tex:12: Undefined control sequence.
`;

const CLASSIC_LOG = `! Missing } inserted.
<inserted text>
l.42 \\end{document}
`;

const WARNING_LOG = `LaTeX Warning: Reference \`fig:one' on page 1 undefined on input line 7.

Overfull \\hbox (15.0pt too wide) in paragraph at lines 12--14

LaTeX Warning: Citation 'smith2020' on page 2 undefined on input line 33.

Underfull \\vbox (badness 10000) has occurred while \\output is active
LaTeX Warning: There were undefined references.
`;

describe("parseCompileDiagnostics", () => {
  it("parses file-line-error format, filtered to the open file, deduped", () => {
    const d = parseCompileDiagnostics(FILE_LINE_LOG, "main.tex");
    expect(d).toEqual([
      { line: 12, message: "Undefined control sequence.", severity: "error" },
    ]);
  });

  it("falls back to classic !/l.N pairing", () => {
    const d = parseCompileDiagnostics(CLASSIC_LOG, "main.tex");
    expect(d).toEqual([
      { line: 42, message: "Missing } inserted.", severity: "error" },
    ]);
  });

  it("extracts line-anchored warnings", () => {
    const d = parseCompileDiagnostics(WARNING_LOG, "main.tex");
    expect(d).toContainEqual({
      line: 7,
      message: "Reference `fig:one' undefined",
      severity: "warning",
    });
    expect(d).toContainEqual({
      line: 33,
      message: "Citation 'smith2020' undefined",
      severity: "warning",
    });
    expect(d).toContainEqual({
      line: 12,
      message: "Overfull \\hbox (15.0pt too wide)",
      severity: "warning",
    });
    // The "There were undefined references" summary has no line — not included.
    expect(d.every((x) => Number.isFinite(x.line))).toBe(true);
  });

  it("puts errors before warnings and respects the cap", () => {
    const d = parseCompileDiagnostics(FILE_LINE_LOG + WARNING_LOG, "main.tex");
    expect(d[0].severity).toBe("error");
  });
});
