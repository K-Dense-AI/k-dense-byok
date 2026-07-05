/**
 * Minimal, dependency-free Newick tree parser (client-side; used by the
 * phylo viewer to render .nwk/.newick/.tree/.nhx files with no backend
 * round-trip). Supports the common subset of the format: nested
 * parenthesized subtrees, `name:length` labels, comma-separated sibling
 * lists, a trailing `;`, single-quoted labels, and NHX-style `[...]`
 * bracket comments (stripped, not interpreted).
 */

export interface PhyloNode {
  name: string;
  length: number | null;
  children: PhyloNode[];
}

/** Characters that terminate an (unquoted) name or a branch-length token. */
const DELIMITERS = ",():;";

/** Strips `[...]` comment/NHX blocks — not quote-aware, but good enough
 *  since real files don't nest brackets inside quoted labels. */
function stripComments(text: string): string {
  return text.replace(/\[[^\]]*\]/g, "");
}

/** Removes whitespace outside of single-quoted labels, so pretty-printed
 *  (multi-line, indented) Newick parses the same as a single-line one. */
function stripUnquotedWhitespace(text: string): string {
  let out = "";
  let inQuote = false;
  for (const ch of text) {
    if (ch === "'") {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

export function parseNewick(text: string): PhyloNode {
  if (typeof text !== "string") {
    throw new Error("Malformed Newick tree: input must be a string");
  }

  const src = stripUnquotedWhitespace(stripComments(text));
  if (src.length === 0) {
    throw new Error("Malformed Newick tree: input is empty");
  }

  let i = 0;
  const n = src.length;

  const fail = (message: string): never => {
    throw new Error(`Malformed Newick tree: ${message} (at position ${i})`);
  };

  const peek = (): string | undefined => src[i];

  function parseName(): string {
    if (peek() === "'") {
      i++; // opening quote
      let name = "";
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            name += "'";
            i += 2;
            continue;
          }
          i++; // closing quote
          return name;
        }
        name += src[i];
        i++;
      }
      return fail("unterminated quoted label");
    }
    const start = i;
    while (i < n && !DELIMITERS.includes(src[i])) i++;
    return src.slice(start, i);
  }

  function parseLength(): number | null {
    if (peek() !== ":") return null;
    i++; // colon
    const start = i;
    while (i < n && !DELIMITERS.includes(src[i])) i++;
    const raw = src.slice(start, i);
    if (raw.length === 0) return fail("expected a branch length after ':'");
    const value = Number(raw);
    if (Number.isNaN(value)) return fail(`invalid branch length "${raw}"`);
    return value;
  }

  function parseSubtree(): PhyloNode {
    const children: PhyloNode[] = [];
    if (peek() === "(") {
      i++; // '('
      children.push(parseSubtree());
      while (peek() === ",") {
        i++;
        children.push(parseSubtree());
      }
      if (peek() !== ")") return fail("expected ')'");
      i++; // ')'
    }
    const name = parseName();
    const length = parseLength();
    return { name, length, children };
  }

  const root = parseSubtree();
  if (peek() === ";") i++;
  if (i !== n) return fail("unexpected trailing characters after tree");

  return root;
}
