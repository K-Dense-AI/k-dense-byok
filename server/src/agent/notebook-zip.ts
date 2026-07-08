/**
 * Bundle a session notebook as a zip: lab-notebook.md (links rewritten to the
 * bundle) + the referenced artifact files under artifacts/<sandbox-relative>.
 * Built in memory (adm-zip toBuffer), consistent with /sandbox/download-all.
 * Artifacts that are missing, escape the sandbox, or aren't regular files are
 * skipped and reported in `missing` (the markdown notes them inline).
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { isWithin } from "../sandbox-fs.ts";
import { notebookToMarkdown } from "./notebook-export.ts";
import type { NotebookEntry } from "./notebook-store.ts";

export interface NotebookZipResult {
  buffer: Buffer;
  missing: string[];
}

/** Wire paths are already forward-slash; normalize defensively for old rows. */
function normalizeRel(rel: string): string {
  return rel.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function buildNotebookZip(
  entries: NotebookEntry[],
  opts: { sessionId: string; projectName?: string; sandboxRoot: string },
): NotebookZipResult {
  const zip = new AdmZip();
  const missing = new Set<string>();
  const bundled = new Map<string, string>(); // original rel → abs path
  for (const e of entries) {
    for (const p of e.artifacts ?? []) {
      if (bundled.has(p) || missing.has(p)) continue;
      const abs = path.resolve(opts.sandboxRoot, normalizeRel(p));
      let ok = false;
      try {
        ok = isWithin(opts.sandboxRoot, abs) && fs.statSync(abs).isFile();
      } catch {
        ok = false;
      }
      if (ok) bundled.set(p, abs);
      else missing.add(p);
    }
  }
  for (const [rel, abs] of bundled) {
    const archived = "artifacts/" + normalizeRel(rel);
    zip.addLocalFile(abs, path.posix.dirname(archived), path.posix.basename(archived));
  }
  const md = notebookToMarkdown(entries, {
    sessionId: opts.sessionId,
    projectName: opts.projectName,
    artifactHref: (p) => (bundled.has(p) ? "artifacts/" + normalizeRel(p) : undefined),
    missingArtifacts: missing,
  });
  zip.addFile("lab-notebook.md", Buffer.from(md, "utf-8"));
  return { buffer: zip.toBuffer(), missing: [...missing] };
}
