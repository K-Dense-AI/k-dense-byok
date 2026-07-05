import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { scanBibFiles, scanBibKeys, scanLabels, latexCompletionSource } from "./completions";

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

function completeAt(doc: string): CompletionResult | null {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, doc.length, true); // explicit=true, cursor at end
  // The source is synchronous; it never returns a Promise.
  return latexCompletionSource({ getBibKeys: () => ["smith2020", "jones1999"] })(
    ctx,
  ) as CompletionResult | null;
}

describe("latexCompletionSource", () => {
  it("completes the first cite key", () => {
    const r = completeAt("\\cite{smi");
    expect(r).not.toBeNull();
    expect(r!.from).toBe("\\cite{".length);
    expect(r!.options.map((o) => o.label)).toContain("smith2020");
  });
  it("completes a second cite key after a comma without clobbering the first", () => {
    const doc = "\\cite{smith2020,jo";
    const r = completeAt(doc);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(doc.length - "jo".length); // fragment start, not after '{'
    expect(r!.options.map((o) => o.label)).toContain("jones1999");
  });
  it("targets only the last label in a multi-label \\cref", () => {
    const doc = "\\cref{alpha,bet";
    const r = completeAt(doc);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(doc.length - "bet".length);
  });
  it("completes an environment name after \\begin{", () => {
    const r = completeAt("\\begin{fig");
    expect(r).not.toBeNull();
    expect(r!.options.some((o) => o.label === "figure")).toBe(true);
  });
});
