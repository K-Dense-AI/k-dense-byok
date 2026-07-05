/**
 * Line-based LaTeX outline parser. Regex-per-line with a tiny float state
 * machine (figure/table pick up their \caption); good enough for real papers
 * and cheap enough to re-run on a 300ms debounce.
 */
export type OutlineKind =
  | "part" | "chapter" | "section" | "subsection" | "subsubsection"
  | "paragraph" | "figure" | "table";

export interface OutlineItem {
  kind: OutlineKind;
  title: string;
  line: number; // 1-based
  depth: number;
}

const SECTION_DEPTH: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5,
};

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/;
const FLOAT_BEGIN_RE = /\\begin\{(figure|table)\*?\}/;
const FLOAT_END_RE = /\\end\{(figure|table)\*?\}/;
const CAPTION_RE = /\\caption\s*(?:\[[^\]]*\])?\{([^}]*)\}/;

/** Strip a trailing unescaped %-comment from a line. */
function stripComment(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "%" && line[i - 1] !== "\\") break;
    out += ch;
  }
  return out;
}

export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split("\n");
  let depth = 1; // before any section
  let float: { kind: "figure" | "table"; line: number; item: OutlineItem } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;

    const sec = SECTION_RE.exec(line);
    if (sec) {
      depth = SECTION_DEPTH[sec[1]];
      items.push({ kind: sec[1] as OutlineKind, title: sec[2].trim(), line: i + 1, depth });
      continue;
    }
    const fb = FLOAT_BEGIN_RE.exec(line);
    if (fb) {
      const item: OutlineItem = {
        kind: fb[1] as "figure" | "table",
        title: fb[1] === "figure" ? "Figure" : "Table",
        line: i + 1,
        depth: depth + 1,
      };
      items.push(item);
      float = { kind: item.kind as "figure" | "table", line: i + 1, item };
      continue;
    }
    if (float) {
      const cap = CAPTION_RE.exec(line);
      if (cap) float.item.title = cap[1].trim();
      if (FLOAT_END_RE.test(line)) float = null;
    }
  }
  return items;
}

/** Enclosing sectioning chain (floats excluded) at or before `line`. */
export function breadcrumbFor(items: OutlineItem[], line: number): OutlineItem[] {
  const chain: OutlineItem[] = [];
  for (const item of items) {
    if (item.line > line) break;
    if (!(item.kind in SECTION_DEPTH)) continue;
    while (chain.length && chain[chain.length - 1].depth >= item.depth) chain.pop();
    chain.push(item);
  }
  return chain;
}
