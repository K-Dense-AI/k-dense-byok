import { describe, expect, it } from "vitest";
import { extractProseTokens, proseWordCount } from "./prose";

describe("extractProseTokens", () => {
  it("extracts plain words with offsets", () => {
    const t = extractProseTokens("Hello brave world");
    expect(t.map((x) => x.word)).toEqual(["Hello", "brave", "world"]);
    expect(t[1]).toEqual({ word: "brave", from: 6, to: 11 });
  });
  it("skips command names but keeps prose arguments", () => {
    const words = extractProseTokens("\\textbf{bold words} here").map((x) => x.word);
    expect(words).toEqual(["bold", "words", "here"]);
  });
  it("skips args of non-prose commands", () => {
    const words = extractProseTokens(
      "See \\ref{fig:xyz} and \\cite{smith2020} for detalis",
    ).map((x) => x.word);
    expect(words).toEqual(["See", "and", "for", "detalis"]);
  });
  it("skips math and comments", () => {
    const words = extractProseTokens(
      "Let $x + y$ be real % a comment word\nokay \\[ e = mc^2 \\] end",
    ).map((x) => x.word);
    expect(words).toEqual(["Let", "be", "real", "okay", "end"]);
  });
  it("skips the preamble when \\begin{document} exists", () => {
    const words = extractProseTokens(
      "\\documentclass{article}\npreamble noise\n\\begin{document}\nreal text\n\\end{document}",
    ).map((x) => x.word);
    expect(words).toEqual(["real", "text"]);
  });
  it("ignores single letters and words with digits", () => {
    const words = extractProseTokens("a x2 hello").map((x) => x.word);
    expect(words).toEqual(["hello"]);
  });
});

describe("proseWordCount", () => {
  it("counts prose words", () => {
    expect(proseWordCount("Hello $x$ world % nope\n\\textit{fine}")).toBe(3);
  });
});
