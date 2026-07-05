/**
 * SyncTeX source<->PDF mapping via the `synctex` CLI (ships with TeX Live).
 *
 * Coordinates: synctex reports PDF points (72/in) with the origin at the
 * TOP-LEFT of the page and y growing downward; `v` is the bottom of the box
 * and `h` its left edge (so the box's top is `v - H`). The frontend maps
 * these straight to CSS pixels by multiplying by its render scale.
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

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

let available: boolean | null = null;
export function synctexAvailable(): boolean {
  if (available === null) {
    available = spawnSync("which", ["synctex"]).status === 0;
  }
  return available;
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

async function run(args: string[]): Promise<string | null> {
  if (!synctexAvailable()) return null;
  try {
    const { stdout } = await execFileAsync("synctex", args, {
      timeout: 10_000,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function synctexForward(
  texAbs: string,
  line: number,
  col: number,
  pdfAbs: string,
): Promise<SynctexBox | null> {
  const out = await run(["view", "-i", `${line}:${col}:${texAbs}`, "-o", pdfAbs]);
  return out ? parseSynctexView(out) : null;
}

export async function synctexInverse(
  pdfAbs: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexLoc | null> {
  const out = await run(["edit", "-o", `${page}:${x}:${y}:${pdfAbs}`]);
  return out ? parseSynctexEdit(out) : null;
}
