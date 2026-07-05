import { describe, expect, it } from "vitest";
import { buildFixPayload, extractPreamble, lineRangeToOffsets } from "./assist-helpers";

const DOC = ["\\documentclass{article}", "\\usepackage{amsmath}", "\\begin{document}",
  ...Array.from({ length: 100 }, (_, i) => `line ${i + 4}`), "\\end{document}"].join("\n");

describe("buildFixPayload", () => {
  it("clamps context to ±40 lines and includes the preamble", () => {
    const p = buildFixPayload(DOC, "main.tex", 50, "Undefined control sequence.");
    expect(p.context.startLine).toBe(10);
    expect(p.context.endLine).toBe(90);
    expect(p.context.text.split("\n")).toHaveLength(81);
    expect(p.preamble).toContain("amsmath");
    expect(p.preamble).not.toContain("line 4");
    expect(p.error).toEqual({ line: 50, message: "Undefined control sequence." });
  });
  it("clamps at document edges", () => {
    const p = buildFixPayload("a\nb\nc", "x.tex", 1, "err");
    expect(p.context.startLine).toBe(1);
    expect(p.context.endLine).toBe(3);
  });
  it("does not throw when the error line is far past EOF (log lines from other files)", () => {
    const p = buildFixPayload("a\nb\nc", "x.tex", 519, "Missing \\begin{document}.");
    expect(p.error.line).toBe(3);
    expect(p.context.startLine).toBe(1);
    expect(p.context.endLine).toBe(3);
    expect(p.context.text).toBe("a\nb\nc");
  });
});

describe("lineRangeToOffsets", () => {
  it("maps 1-based line ranges to character offsets", () => {
    expect(lineRangeToOffsets("ab\ncd\nef", 2, 3)).toEqual({ from: 3, to: 8 });
    expect(lineRangeToOffsets("ab\ncd\nef", 1, 1)).toEqual({ from: 0, to: 2 });
  });
  it("clamps out-of-range lines instead of reading past the array", () => {
    expect(lineRangeToOffsets("ab\ncd", 5, 9)).toEqual({ from: 3, to: 5 });
    expect(lineRangeToOffsets("ab\ncd", 0, 99)).toEqual({ from: 0, to: 5 });
  });
});

describe("extractPreamble", () => {
  it("ignores a commented-out %\\begin{document}", () => {
    const doc = [
      "\\usepackage{amsmath}",
      "%\\begin{document}",
      "\\usepackage{siunitx}",
      "\\begin{document}",
      "body",
    ].join("\n");
    const p = extractPreamble(doc);
    expect(p).toContain("siunitx");
    expect(p).not.toContain("body");
  });
  it("returns empty for fragment files without \\begin{document}", () => {
    expect(extractPreamble("\\section{Intro}\ntext")).toBe("");
  });
});
