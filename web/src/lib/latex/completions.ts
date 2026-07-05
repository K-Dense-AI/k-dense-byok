/**
 * Autocomplete sources for LaTeX: common commands + math symbols,
 * environments (with auto-inserted \end), snippets, and context-aware
 * \ref / \cite completion backed by document + .bib scans.
 */
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";

// ---- scanners --------------------------------------------------------------

export function scanLabels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

export function scanBibFiles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\\bibliography\{([^}]+)\}/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name) out.push(name.endsWith(".bib") ? name : `${name}.bib`);
    }
  }
  for (const m of text.matchAll(/\\addbibresource\{([^}]+)\}/g)) {
    out.push(m[1].trim());
  }
  return out;
}

export function scanBibKeys(bibText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of bibText.matchAll(/^\s*@(\w+)\s*[({]\s*([^,\s()]+)\s*,/gm)) {
    if (m[1].toLowerCase() === "comment" || m[1].toLowerCase() === "string") continue;
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push(m[2]);
    }
  }
  return out;
}

// ---- static data -----------------------------------------------------------

const cmd = (label: string, detail?: string): Completion => ({
  label, type: "keyword", detail,
});
const sym = (label: string, detail: string): Completion => ({
  label, type: "variable", detail,
});

export const LATEX_COMMANDS: Completion[] = [
  // Structure
  cmd("\\documentclass{}"), cmd("\\usepackage{}"), cmd("\\begin{}"), cmd("\\end{}"),
  cmd("\\section{}"), cmd("\\subsection{}"), cmd("\\subsubsection{}"),
  cmd("\\paragraph{}"), cmd("\\chapter{}"), cmd("\\part{}"), cmd("\\appendix"),
  cmd("\\title{}"), cmd("\\author{}"), cmd("\\date{}"), cmd("\\maketitle"),
  cmd("\\tableofcontents"), cmd("\\input{}"), cmd("\\include{}"),
  cmd("\\label{}"), cmd("\\ref{}"), cmd("\\eqref{}"), cmd("\\pageref{}"),
  cmd("\\cite{}"), cmd("\\citep{}"), cmd("\\citet{}"), cmd("\\footnote{}"),
  cmd("\\bibliography{}"), cmd("\\bibliographystyle{}"), cmd("\\addbibresource{}"),
  cmd("\\printbibliography"),
  // Text formatting
  cmd("\\textbf{}", "bold"), cmd("\\textit{}", "italic"), cmd("\\texttt{}", "monospace"),
  cmd("\\textsc{}", "small caps"), cmd("\\emph{}"), cmd("\\underline{}"),
  cmd("\\textsuperscript{}"), cmd("\\textsubscript{}"),
  cmd("\\tiny"), cmd("\\small"), cmd("\\normalsize"), cmd("\\large"), cmd("\\Large"), cmd("\\huge"),
  cmd("\\centering"), cmd("\\raggedright"), cmd("\\noindent"),
  cmd("\\newline"), cmd("\\newpage"), cmd("\\clearpage"), cmd("\\linebreak"),
  cmd("\\vspace{}"), cmd("\\hspace{}"), cmd("\\quad"), cmd("\\qquad"),
  cmd("\\item"), cmd("\\caption{}"), cmd("\\includegraphics[]{}"),
  cmd("\\url{}"), cmd("\\href{}{}"), cmd("\\verb||"),
  cmd("\\newcommand{}{}"), cmd("\\renewcommand{}{}"), cmd("\\def"),
  cmd("\\hline"), cmd("\\toprule"), cmd("\\midrule"), cmd("\\bottomrule"),
  cmd("\\multicolumn{}{}{}"), cmd("\\multirow{}{}{}"),
  // Math
  cmd("\\frac{}{}"), cmd("\\dfrac{}{}"), cmd("\\sqrt{}"), cmd("\\sum"), cmd("\\prod"),
  cmd("\\int"), cmd("\\oint"), cmd("\\lim"), cmd("\\infty"), cmd("\\partial"),
  cmd("\\nabla"), cmd("\\cdot"), cmd("\\times"), cmd("\\pm"), cmd("\\mp"),
  cmd("\\leq"), cmd("\\geq"), cmd("\\neq"), cmd("\\approx"), cmd("\\sim"), cmd("\\equiv"),
  cmd("\\in"), cmd("\\notin"), cmd("\\subset"), cmd("\\subseteq"), cmd("\\cup"), cmd("\\cap"),
  cmd("\\rightarrow"), cmd("\\leftarrow"), cmd("\\Rightarrow"), cmd("\\Leftrightarrow"),
  cmd("\\mapsto"), cmd("\\forall"), cmd("\\exists"),
  cmd("\\mathbb{}"), cmd("\\mathcal{}"), cmd("\\mathrm{}"), cmd("\\mathbf{}"), cmd("\\mathit{}"),
  cmd("\\hat{}"), cmd("\\bar{}"), cmd("\\vec{}"), cmd("\\tilde{}"), cmd("\\dot{}"), cmd("\\ddot{}"),
  cmd("\\overline{}"), cmd("\\underbrace{}"), cmd("\\overbrace{}"),
  cmd("\\left("), cmd("\\right)"), cmd("\\left["), cmd("\\right]"), cmd("\\langle"), cmd("\\rangle"),
  cmd("\\text{}"), cmd("\\operatorname{}"), cmd("\\binom{}{}"),
  cmd("\\sin"), cmd("\\cos"), cmd("\\tan"), cmd("\\log"), cmd("\\ln"), cmd("\\exp"),
  cmd("\\min"), cmd("\\max"), cmd("\\arg"), cmd("\\det"),
  // Greek
  sym("\\alpha", "α"), sym("\\beta", "β"), sym("\\gamma", "γ"), sym("\\delta", "δ"),
  sym("\\epsilon", "ε"), sym("\\varepsilon", "ε"), sym("\\zeta", "ζ"), sym("\\eta", "η"),
  sym("\\theta", "θ"), sym("\\iota", "ι"), sym("\\kappa", "κ"), sym("\\lambda", "λ"),
  sym("\\mu", "μ"), sym("\\nu", "ν"), sym("\\xi", "ξ"), sym("\\pi", "π"),
  sym("\\rho", "ρ"), sym("\\sigma", "σ"), sym("\\tau", "τ"), sym("\\upsilon", "υ"),
  sym("\\phi", "φ"), sym("\\varphi", "φ"), sym("\\chi", "χ"), sym("\\psi", "ψ"),
  sym("\\omega", "ω"), sym("\\Gamma", "Γ"), sym("\\Delta", "Δ"), sym("\\Theta", "Θ"),
  sym("\\Lambda", "Λ"), sym("\\Xi", "Ξ"), sym("\\Pi", "Π"), sym("\\Sigma", "Σ"),
  sym("\\Phi", "Φ"), sym("\\Psi", "Ψ"), sym("\\Omega", "Ω"),
];

export const LATEX_ENVIRONMENTS: string[] = [
  "document", "abstract", "figure", "table", "tabular", "tabularx", "array",
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline",
  "itemize", "enumerate", "description", "quote", "quotation", "verbatim",
  "center", "flushleft", "flushright", "minipage", "matrix", "pmatrix",
  "bmatrix", "vmatrix", "cases", "split", "theorem", "lemma", "proof",
  "definition", "example", "remark", "algorithm", "lstlisting", "frame",
  "titlepage", "thebibliography", "appendix", "subfigure", "wrapfigure",
];

export const LATEX_SNIPPETS: Completion[] = [
  snippetCompletion(
    "\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=${0.8}\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}",
    { label: "figure", detail: "figure skeleton", type: "class" },
  ),
  snippetCompletion(
    "\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{${lcr}}\n\t\t\\toprule\n\t\t${header} \\\\\n\t\t\\midrule\n\t\t${row} \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}",
    { label: "table", detail: "booktabs table skeleton", type: "class" },
  ),
  snippetCompletion(
    "\\begin{equation}\n\t${x = y}\n\t\\label{eq:${label}}\n\\end{equation}",
    { label: "equation", detail: "numbered equation", type: "class" },
  ),
  snippetCompletion(
    "\\begin{align}\n\t${a} &= ${b} \\\\\n\t&= ${c}\n\\end{align}",
    { label: "align", detail: "aligned equations", type: "class" },
  ),
  snippetCompletion(
    "\\begin{itemize}\n\t\\item ${first}\n\t\\item ${second}\n\\end{itemize}",
    { label: "itemize", detail: "bullet list", type: "class" },
  ),
  snippetCompletion(
    "\\begin{enumerate}\n\t\\item ${first}\n\t\\item ${second}\n\\end{enumerate}",
    { label: "enumerate", detail: "numbered list", type: "class" },
  ),
];

// ---- completion source -----------------------------------------------------

const REF_CMD_RE = /\\(?:ref|eqref|autoref|cref|Cref|pageref|vref)\{([^}]*)$/;
const CITE_CMD_RE =
  /\\(?:cite|citep|citet|citeauthor|citeyear|textcite|parencite|autocite)(?:\[[^\]]*\])*\{([^},]*)$/;
const BEGIN_RE = /\\begin\{([a-zA-Z*]*)$/;
const COMMAND_RE = /\\[a-zA-Z]*$/;

export function latexCompletionSource(opts: {
  getBibKeys: () => string[];
}): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);

    const ref = REF_CMD_RE.exec(before);
    if (ref) {
      const labels = scanLabels(context.state.doc.toString());
      return {
        from: context.pos - ref[1].length,
        options: labels.map((l) => ({ label: l, type: "constant" })),
        validFor: /^[^}]*$/,
      };
    }
    const cite = CITE_CMD_RE.exec(before);
    if (cite) {
      return {
        from: context.pos - cite[1].length,
        options: opts.getBibKeys().map((k) => ({ label: k, type: "constant" })),
        validFor: /^[^},]*$/,
      };
    }
    const env = BEGIN_RE.exec(before);
    if (env) {
      return {
        from: context.pos - env[1].length,
        options: LATEX_ENVIRONMENTS.map((name) =>
          snippetCompletion(`${name}}\n\t\${}\n\\end{${name}}`, {
            label: name, type: "class",
          }),
        ),
        validFor: /^[a-zA-Z*]*$/,
      };
    }
    const cmdMatch = COMMAND_RE.exec(before);
    if (cmdMatch && (context.explicit || cmdMatch[0].length > 1)) {
      return {
        from: context.pos - cmdMatch[0].length,
        options: [...LATEX_COMMANDS, ...LATEX_SNIPPETS],
        validFor: /^\\[a-zA-Z]*$/,
      };
    }
    return null;
  };
}
