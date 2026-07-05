import { describe, expect, it } from "vitest";
import { buildFixPayload, lineRangeToOffsets } from "./assist-helpers";

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
});

describe("lineRangeToOffsets", () => {
  it("maps 1-based line ranges to character offsets", () => {
    expect(lineRangeToOffsets("ab\ncd\nef", 2, 3)).toEqual({ from: 3, to: 8 });
    expect(lineRangeToOffsets("ab\ncd\nef", 1, 1)).toEqual({ from: 0, to: 2 });
  });
});
