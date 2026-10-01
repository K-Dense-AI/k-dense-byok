import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBinary } from "../src/binaries.ts";
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
  it("honors biblatex's explicit bibtex backend, including multiline options", () => {
    expect(detectBibTool("\\usepackage[\nbackend = bibtex,\nstyle=numeric\n]{biblatex}\n\\addbibresource{refs.bib}")).toBe("bibtex");
    expect(detectBibTool("% \\usepackage[backend=bibtex]{biblatex}\n\\usepackage{biblatex}")).toBe("biber");
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
      ["latexmk", "-norc", "-pdflatex", "-interaction=nonstopmode", "-cd", "-file-line-error", "-synctex=1", "/s/main.tex"],
    ]);
  });
  it("never reads a latexmkrc from the document folder, but keeps the user's own", () => {
    const plan = buildCompilePlan({
      engine: "pdflatex", targetAbs: "/s/main.tex", hasLatexmk: true, bibTool: null, userRc: "/home/u/.latexmkrc",
    });
    expect(plan[0].slice(0, 4)).toEqual(["latexmk", "-norc", "-r", "/home/u/.latexmkrc"]);
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

const hasPdflatex = hasBinary("pdflatex");

describe.skipIf(!hasPdflatex)("compileLatex (integration, real TeX)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  function makeDoc(body: string): { dir: string; tex: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-latex-"));
    dirs.push(dir);
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

  it.skipIf(!hasBinary("bibtex"))("retains bibliography failure even when later engine passes succeed", async () => {
    const { dir, tex } = makeDoc("\\documentclass{article}\n\\begin{document}\nHello \\cite{missing}.\n\\bibliographystyle{plain}\n\\bibliography{not-present}\n\\end{document}\n");
    const res = await compileLatex(tex, "pdflatex", dir, { useLatexmk: false });
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.includes("bibtex failed"))).toBe(true);
    expect(res.pdf_path).toBeNull();
    expect(res.synctex).toBe(false);
    // A PDF exists, but a failed bibliography must not be reported as ready.
    expect(fs.existsSync(path.join(dir, "main.pdf"))).toBe(true);
  }, 30_000);

  it("keeps errors at the beginning of long logs and does not publish a failed PDF", async () => {
    const { dir, tex } = makeDoc("\\documentclass{article}\n\\begin{document}\n\\badmacro\n" + "\\typeout{abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnop}\n".repeat(1200) + "Hello\\end{document}\n");
    const res = await compileLatex(tex, "pdflatex", dir, { useLatexmk: false });
    expect(res.success).toBe(false);
    expect(res.log).toContain("Undefined control sequence");
    expect(res.log).toContain("[Compilation log truncated]");
    expect(res.log.length).toBeLessThanOrEqual(64_000);
    expect(res.pdf_path).toBeNull();
  }, 30_000);

  it("separates final diagnostics from cross-reference warnings resolved by reruns", async () => {
    const { dir, tex } = makeDoc("\\documentclass{article}\n\\begin{document}\nSee section \\ref{sec:hello}.\n\\section{Hello}\\label{sec:hello}\n\\end{document}\n");
    const res = await compileLatex(tex, "pdflatex", dir, { useLatexmk: false });
    expect(res.success).toBe(true);
    expect(res.log).toContain("undefined");
    expect(res.diagnostics_log).not.toContain("undefined");
  }, 30_000);
});
