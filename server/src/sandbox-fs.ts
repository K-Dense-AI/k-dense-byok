/**
 * Sandbox path-safety, visibility rules, and mime guessing — TS port of
 * sandbox_visibility.py plus the _safe_path guard from api/sandbox.py.
 */
import fs from "node:fs";
import path from "node:path";
import { activePaths } from "./projects.ts";

export const USER_HIDDEN_NAMES = new Set(["GEMINI.md", "uv.lock"]);

export class SandboxError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve a sandbox-relative path, refusing traversal outside the sandbox. */
export function safePath(rel: string): string {
  const sandbox = activePaths().sandbox;
  const target = path.resolve(sandbox, rel);
  if (!isWithin(sandbox, target)) {
    throw new SandboxError(403, "Path traversal denied");
  }
  // path.resolve() is purely lexical — a symlink inside the sandbox can still
  // point outside it. Canonicalize the deepest existing ancestor and re-check.
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const realSandbox = fs.realpathSync(sandbox);
    const realTarget = fs.realpathSync(existing);
    if (!isWithin(realSandbox, realTarget)) {
      throw new SandboxError(403, "Path traversal denied");
    }
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    /* sandbox not created yet → nothing on disk to escape through */
  }
  return target;
}

export function isUserVisible(absPath: string, sandboxRoot: string): boolean {
  const rel = path.relative(sandboxRoot, absPath);
  if (rel === "") return true;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p.startsWith("."))) return false;
  const name = path.basename(absPath);
  if (USER_HIDDEN_NAMES.has(name)) return false;
  if (name.endsWith(".annotations.json")) return false;
  return true;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".tex": "text/x-tex",
  ".pdb": "chemical/x-pdb",
  ".ent": "chemical/x-pdb",
  ".cif": "chemical/x-cif",
  ".mmcif": "chemical/x-cif",
  ".xyz": "chemical/x-xyz",
  ".gro": "chemical/x-gromacs",
  ".pdbqt": "chemical/x-pdb",
  ".mol": "chemical/x-mdl-molfile",
  ".sdf": "chemical/x-mdl-sdfile",
  ".mol2": "chemical/x-mol2",
  ".smi": "text/plain",
  ".smiles": "text/plain",
  ".inchi": "text/plain",
  ".mzml": "application/xml",
  ".mzxml": "application/xml",
  ".mgf": "text/plain",
  ".jdx": "chemical/x-jcamp-dx",
  ".dx": "chemical/x-jcamp-dx",
};

export function guessMime(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}
