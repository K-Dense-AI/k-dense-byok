/**
 * Prose tokenizer for spell checking and word count. A single-pass scanner
 * that skips: the preamble (when \begin{document} exists), %-comments,
 * inline ($...$, \( \)) and display ($$..$$, \[ \]) math, math environments,
 * command names, and arguments of commands whose args aren't prose.
 */
export interface ProseToken {
  word: string;
  from: number;
  to: number;
}

const NONPROSE_ARG_COMMANDS = new Set([
  "label", "ref", "pageref", "eqref", "autoref", "cref", "Cref", "vref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "textcite", "parencite", "autocite",
  "includegraphics", "input", "include", "bibliography", "bibliographystyle",
  "addbibresource", "usepackage", "documentclass", "begin", "end", "url",
]);

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "math", "displaymath",
]);

const WORD_RE = /^[A-Za-z][A-Za-z']+$/;

export function extractProseTokens(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  const docStart = text.indexOf("\\begin{document}");
  let i = docStart >= 0 ? docStart + "\\begin{document}".length : 0;
  let mathEnvDepth = 0;

  const flushWord = (from: number, to: number) => {
    const word = text.slice(from, to);
    if (word.length >= 2 && WORD_RE.test(word) && !/\d/.test(word)) {
      tokens.push({ word, from, to });
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "%" && text[i - 1] !== "\\") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "$") {
      const display = text[i + 1] === "$";
      i += display ? 2 : 1;
      while (i < text.length) {
        if (text[i] === "$" && text[i - 1] !== "\\") {
          i += display && text[i + 1] === "$" ? 2 : 1;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(close, i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "\\") {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      i = j;
      // \begin{env}/\end{env}: track math environments
      if (name === "begin" || name === "end") {
        const m = /^\{([a-zA-Z*]+)\}/.exec(text.slice(i));
        if (m) {
          if (MATH_ENVS.has(m[1])) {
            mathEnvDepth = Math.max(0, mathEnvDepth + (name === "begin" ? 1 : -1));
          }
          i += m[0].length;
        }
        continue;
      }
      if (NONPROSE_ARG_COMMANDS.has(name) || name === "href") {
        // Skip optional [..] then required {..} arg(s). \href skips only its
        // first {url} arg; the second (display text) is prose.
        const opt = /^\[[^\]]*\]/.exec(text.slice(i));
        if (opt) i += opt[0].length;
        const braced = /^\{[^}]*\}/.exec(text.slice(i));
        if (braced) i += braced[0].length;
      }
      continue;
    }
    if (mathEnvDepth > 0) {
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z']/.test(text[i])) i++;
      flushWord(start, i);
      continue;
    }
    i++;
  }
  return tokens;
}

export function proseWordCount(text: string): number {
  return extractProseTokens(text).length;
}
