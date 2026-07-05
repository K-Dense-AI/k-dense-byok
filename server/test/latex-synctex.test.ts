import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileLatex } from "../src/latex/compile.ts";
import {
  parseSynctexEdit,
  parseSynctexView,
  synctexAvailable,
  synctexForward,
  synctexInverse,
} from "../src/latex/synctex.ts";

const VIEW_OUTPUT = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/tmp/x/main.pdf
Page:2
x:148.712997
y:194.045990
h:133.768356
v:196.535963
W:343.711975
H:8.966400
before:
offset:0
middle:
after:
SyncTeX result end
`;

const EDIT_OUTPUT = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/tmp/x/main.pdf
Input:/tmp/x/main.tex
Line:42
Column:-1
Offset:0
Context:
SyncTeX result end
`;

describe("parseSynctexView", () => {
  it("extracts the first result box", () => {
    expect(parseSynctexView(VIEW_OUTPUT)).toEqual({
      page: 2, h: 133.768356, v: 196.535963, W: 343.711975, H: 8.9664,
    });
  });
  it("returns null when there is no result", () => {
    expect(parseSynctexView("SyncTeX result begin\nSyncTeX result end\n")).toBeNull();
    expect(parseSynctexView("")).toBeNull();
  });
});

describe("parseSynctexEdit", () => {
  it("extracts input file and line", () => {
    expect(parseSynctexEdit(EDIT_OUTPUT)).toEqual({
      file: "/tmp/x/main.tex", line: 42, column: -1,
    });
  });
  it("returns null without a result", () => {
    expect(parseSynctexEdit("nope")).toBeNull();
  });
});

const canRun =
  synctexAvailable() && spawnSync("which", ["pdflatex"]).status === 0;

describe.skipIf(!canRun)("synctex CLI (integration)", () => {
  it("round-trips forward then inverse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-synctex-"));
    const tex = path.join(dir, "main.tex");
    fs.writeFileSync(
      tex,
      "\\documentclass{article}\n\\begin{document}\nHello synctex world.\n\\end{document}\n",
    );
    const compiled = await compileLatex(tex, "pdflatex", dir);
    expect(compiled.synctex).toBe(true);
    const pdf = path.join(dir, "main.pdf");

    const box = await synctexForward(tex, 3, 0, pdf);
    expect(box).not.toBeNull();
    expect(box!.page).toBe(1);
    expect(box!.W).toBeGreaterThan(0);

    const loc = await synctexInverse(pdf, box!.page, box!.h + 1, box!.v - 1);
    expect(loc).not.toBeNull();
    expect(loc!.file.endsWith("main.tex")).toBe(true);
    expect(loc!.line).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
