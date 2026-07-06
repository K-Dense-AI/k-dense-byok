/**
 * SyncTeX source<->PDF mapping via the `synctex` CLI (ships with TeX Live).
 *
 * Coordinates: synctex reports PDF points (72/in) with the origin at the
 * TOP-LEFT of the page and y growing downward; `v` is the bottom of the box
 * and `h` its left edge (so the box's top is `v - H`). The frontend maps
 * these straight to CSS pixels by multiplying by its render scale.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { hasBinary } from "../binaries.ts";
import { toApiPath } from "../sandbox-fs.ts";

const execFileAsync = promisify(execFile);

export interface SynctexBox {
  page: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface SynctexLoc {
  file: string;
  line: number;
  column: number;
}

export function synctexAvailable(): boolean {
  return hasBinary("synctex");
}

function num(re: RegExp, out: string): number | null {
  const m = re.exec(out);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseSynctexView(out: string): SynctexBox | null {
  const page = num(/^Page:(\d+)/m, out);
  const h = num(/^h:([-\d.]+)/m, out);
  const v = num(/^v:([-\d.]+)/m, out);
  const W = num(/^W:([-\d.]+)/m, out);
  const H = num(/^H:([-\d.]+)/m, out);
  if (page === null || h === null || v === null || W === null || H === null) {
    return null;
  }
  return { page, h, v, W, H };
}

export function parseSynctexEdit(out: string): SynctexLoc | null {
  const file = /^Input:(.+)$/m.exec(out)?.[1]?.trim();
  const line = num(/^Line:(-?\d+)/m, out);
  const column = num(/^Column:(-?\d+)/m, out);
  if (!file || line === null || line < 1) return null;
  return { file, line, column: column ?? -1 };
}

async function run(args: string[], cwd?: string): Promise<string | null> {
  if (!synctexAvailable()) return null;
  try {
    const { stdout } = await execFileAsync("synctex", args, {
      cwd,
      timeout: 10_000,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

type PathImpl = Pick<typeof path, "dirname" | "basename" | "relative" | "sep">;

export interface ForwardInvocation {
  cwd: string;
  /** Input spellings to try in order: relative-to-cwd, then absolute with
   *  forward slashes — whichever matches the .synctex Input records. */
  inputs: string[];
  args: (input: string) => string[];
}

/**
 * Build the `synctex view`/`edit` invocations relative to the PDF's directory.
 * synctex's `-i`/`-o` values are colon-delimited, so a Windows drive letter
 * (`C:\...`) inside them would collide with the delimiter — running from the
 * PDF's directory keeps the fields to basenames/relative paths. The path impl
 * is injectable so Windows behavior is unit-testable from any host OS.
 */
export function forwardArgs(
  texAbs: string,
  line: number,
  col: number,
  pdfAbs: string,
  p: PathImpl = path,
): ForwardInvocation {
  const cwd = p.dirname(pdfAbs);
  const relTex = toApiPath(p.relative(cwd, texAbs), p.sep);
  const absTex = toApiPath(texAbs, p.sep);
  return {
    cwd,
    inputs: [...new Set([relTex, absTex])],
    args: (input) => ["view", "-i", `${line}:${col}:${input}`, "-o", p.basename(pdfAbs)],
  };
}

export function inverseArgs(
  pdfAbs: string,
  page: number,
  x: number,
  y: number,
  p: PathImpl = path,
): { cwd: string; args: string[] } {
  return {
    cwd: p.dirname(pdfAbs),
    args: ["edit", "-o", `${page}:${x}:${y}:${p.basename(pdfAbs)}`],
  };
}

export async function synctexForward(
  texAbs: string,
  line: number,
  col: number,
  pdfAbs: string,
): Promise<SynctexBox | null> {
  const inv = forwardArgs(texAbs, line, col, pdfAbs);
  for (const input of inv.inputs) {
    const out = await run(inv.args(input), inv.cwd);
    const box = out ? parseSynctexView(out) : null;
    if (box) return box;
  }
  return null;
}

export async function synctexInverse(
  pdfAbs: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexLoc | null> {
  const inv = inverseArgs(pdfAbs, page, x, y);
  const out = await run(inv.args, inv.cwd);
  return out ? parseSynctexEdit(out) : null;
}
