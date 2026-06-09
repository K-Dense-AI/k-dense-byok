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

/** Resolve a sandbox-relative path, refusing traversal outside the sandbox. */
export function safePath(rel: string): string {
  const sandbox = activePaths().sandbox;
  const target = path.resolve(sandbox, rel);
  if (target !== sandbox && !target.startsWith(sandbox + path.sep)) {
    throw new SandboxError(403, "Path traversal denied");
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
};

export function guessMime(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export { fs, path };
