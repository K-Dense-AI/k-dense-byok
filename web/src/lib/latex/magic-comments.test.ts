import { describe, expect, it } from "vitest";
import { parseMagicComments, resolveRelative } from "./magic-comments";

describe("parseMagicComments", () => {
  it("parses root and program", () => {
    const r = parseMagicComments("% !TEX root = ../main.tex\n% !TEX program = xelatex\n\\section{x}");
    expect(r).toEqual({ root: "../main.tex", program: "xelatex" });
  });
  it("is case-insensitive and accepts TS-program", () => {
    const r = parseMagicComments("%!tex ROOT = main.tex\n% !TeX TS-program = lualatex");
    expect(r).toEqual({ root: "main.tex", program: "lualatex" });
  });
  it("only scans the first 15 lines", () => {
    const pad = Array(20).fill("x").join("\n");
    expect(parseMagicComments(`${pad}\n% !TEX root = a.tex`)).toEqual({});
  });
});

describe("resolveRelative", () => {
  it("resolves against the file's directory", () => {
    expect(resolveRelative("chapters/ch1.tex", "../main.tex")).toBe("main.tex");
    expect(resolveRelative("main.tex", "refs.bib")).toBe("refs.bib");
    expect(resolveRelative("a/b/c.tex", "d.bib")).toBe("a/b/d.bib");
  });
  it("clamps escapes above the sandbox root", () => {
    expect(resolveRelative("main.tex", "../../etc/passwd")).toBe("etc/passwd");
  });
});
