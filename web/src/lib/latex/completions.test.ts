import { describe, expect, it } from "vitest";
import { scanBibFiles, scanBibKeys, scanLabels } from "./completions";

describe("scanLabels", () => {
  it("collects unique labels in order", () => {
    const text = "\\label{fig:a}\n\\label{eq:b}\n\\label{fig:a}";
    expect(scanLabels(text)).toEqual(["fig:a", "eq:b"]);
  });
});

describe("scanBibFiles", () => {
  it("handles classic \\bibliography with commas and missing extensions", () => {
    expect(scanBibFiles("\\bibliography{refs,other.bib}")).toEqual(["refs.bib", "other.bib"]);
  });
  it("handles \\addbibresource", () => {
    expect(scanBibFiles("\\addbibresource{lib.bib}")).toEqual(["lib.bib"]);
  });
});

describe("scanBibKeys", () => {
  it("extracts entry keys", () => {
    const bib = `@article{smith2020,\n title={X}\n}\n@book (jones1999,\n)\n@comment{ignored}`;
    expect(scanBibKeys(bib)).toEqual(["smith2020", "jones1999"]);
  });
});
