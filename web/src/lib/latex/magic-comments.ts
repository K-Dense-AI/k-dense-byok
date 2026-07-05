/** TeXShop/latexmk-style magic comments, honored by every serious editor. */
export interface MagicComments {
  root?: string;
  program?: string;
}

const ROOT_RE = /^%\s*!\s*tex\s+root\s*=\s*(.+)$/i;
const PROGRAM_RE = /^%\s*!\s*tex\s+(?:ts-)?program\s*=\s*(\S+)/i;

export function parseMagicComments(text: string): MagicComments {
  const out: MagicComments = {};
  const lines = text.split("\n", 15);
  for (const line of lines) {
    const root = ROOT_RE.exec(line.trim());
    if (root && !out.root) out.root = root[1].trim();
    const prog = PROGRAM_RE.exec(line.trim());
    if (prog && !out.program) out.program = prog[1].trim().toLowerCase();
  }
  return out;
}

/** Resolve `rel` against fromPath's directory; sandbox-relative, clamped. */
export function resolveRelative(fromPath: string, rel: string): string {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" + rel : rel).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      stack.pop(); // pops nothing at root — clamps escapes
      continue;
    }
    stack.push(p);
  }
  return stack.join("/");
}
