import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LATEX_ENGINES,
  buildCompilePlan,
  compileLatex,
  detectBibTool,
} from "../src/latex/compile.ts";

describe("detectBibTool", () => {
  it("detects biber for biblatex/addbibresource", () => {
    expect(detectBibTool("\\usepackage{biblatex}\n\\addbibresource{x.bib}")).toBe("biber");
    expect(detectBibTool("\\usepackage[backend=biber]{biblatex}")).toBe("biber");
  });
  it("detects bibtex for classic \\bibliography", () => {
    expect(detectBibTool("\\bibliography{refs}")).toBe("bibtex");
  });
  it("ignores commented-out lines and returns null otherwise", () => {
    expect(detectBibTool("% \\bibliography{refs}")).toBeNull();
    expect(detectBibTool("\\section{Hi}")).toBeNull();
  });
});

describe("buildCompilePlan", () => {
  it("uses a single latexmk invocation with synctex when available", () => {
    const plan = buildCompilePlan({
      engine: "pdflatex", targetAbs: "/s/main.tex", hasLatexmk: true, bibTool: "bibtex",
    });
    expect(plan).toEqual([
      ["latexmk", "-pdflatex", "-interaction=nonstopmode", "-cd", "-file-line-error", "-synctex=1", "/s/main.tex"],
    ]);
  });
  it("without latexmk runs engine, bib tool, then two more engine passes", () => {
    const plan = buildCompilePlan({
      engine: "xelatex", targetAbs: "/s/dir/main.tex", hasLatexmk: false, bibTool: "biber",
    });
    const engine = ["xelatex", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "main.tex"];
    expect(plan).toEqual([engine, ["biber", "main"], engine, engine]);
  });
  it("without latexmk and no bibliography runs two engine passes", () => {
    const plan = buildCompilePlan({
      engine: "pdflatex", targetAbs: "/s/main.tex", hasLatexmk: false, bibTool: null,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0][0]).toBe("pdflatex");
  });
});

describe("LATEX_ENGINES", () => {
  it("contains exactly the supported engines", () => {
    expect([...LATEX_ENGINES].sort()).toEqual(["lualatex", "pdflatex", "xelatex"]);
  });
});

const hasPdflatex = spawnSync("which", ["pdflatex"]).status === 0;

describe.skipIf(!hasPdflatex)("compileLatex (integration, real TeX)", () => {
  function makeDoc(body: string): { dir: string; tex: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-latex-"));
    const tex = path.join(dir, "main.tex");
    fs.writeFileSync(tex, body);
    return { dir, tex };
  }

  it("compiles a valid doc, reports synctex, coalesces concurrent calls", async () => {
    const { dir, tex } = makeDoc(
      "\\documentclass{article}\\begin{document}Hello\\end{document}\n",
    );
    const [a, b] = await Promise.all([
      compileLatex(tex, "pdflatex", dir),
      compileLatex(tex, "pdflatex", dir),
    ]);
    expect(a.success).toBe(true);
    expect(a.pdf_path).toBe("main.pdf");
    expect(a.synctex).toBe(true);
    expect(b).toBe(a); // coalesced: same resolved object
    expect(fs.existsSync(path.join(dir, "main.pdf"))).toBe(true);
  }, 120_000);

  it("reports failure with parsed errors for a broken doc", async () => {
    const { dir, tex } = makeDoc(
      "\\documentclass{article}\\begin{document}\\badmacro\\end{document}\n",
    );
    const res = await compileLatex(tex, "pdflatex", dir);
    expect(res.success).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.log).toContain("badmacro");
  }, 120_000);

  it("returns a compiler-not-found message for a missing engine", async () => {
    const { dir, tex } = makeDoc("\\documentclass{article}\\begin{document}x\\end{document}\n");
    // Force the direct-engine path so the fake engine binary hits ENOENT.
    const res = await compileLatex(tex, "pdflatex-does-not-exist", dir, { useLatexmk: false });
    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/not found/i);
  }, 30_000);
});
