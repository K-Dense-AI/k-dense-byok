/**
 * Complete project archive used by GET /sandbox/download-all.
 *
 * User-visible sandbox files keep their existing paths at the archive root.
 * Hidden application state stays hidden, except for explicit, portable exports
 * of user-facing chat sessions and Living Lab Notebook data.
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import type { ProjectPaths } from "./projects.ts";
import { apiRelative, isUserVisible, isWithin } from "./sandbox-fs.ts";
import { readNotebookAnnotations } from "./agent/notebook-annotations.ts";
import { notebookToMarkdown } from "./agent/notebook-export.ts";
import {
  isValidSessionId,
  readProjectNotebooks,
  type NotebookEntry,
} from "./agent/notebook-store.ts";
import { toNotebook } from "./agent/session-export.ts";
import { listSessions } from "./agent/session-registry.ts";

type ArchiveSession = Awaited<ReturnType<typeof listSessions>>[number];

export interface ProjectArchiveOptions {
  paths: ProjectPaths;
  projectName?: string;
  /** Test seam; production always uses the same list as GET /sessions. */
  sessions?: ArchiveSession[];
}

export interface ProjectArchiveResult {
  buffer: Buffer;
  entryCount: number;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function addLocalFile(zip: AdmZip, file: string, archived: string): void {
  zip.addLocalFile(
    file,
    path.posix.dirname(archived),
    path.posix.basename(archived),
  );
}

function addVisibleSandboxFiles(
  zip: AdmZip,
  root: string,
  occupiedRoots: Set<string>,
): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (!isUserVisible(abs, root)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = apiRelative(root, abs);
        addLocalFile(zip, abs, rel);
        occupiedRoots.add(rel.split("/")[0]);
        count++;
      }
    }
  };
  walk(root);
  return count;
}

/** Avoid replacing a user's own top-level chat-history/ or notebook/ folder. */
function availableRoot(preferred: string, occupied: Set<string>): string {
  if (!occupied.has(preferred)) {
    occupied.add(preferred);
    return preferred;
  }
  const fallback = `${preferred}-kady-export`;
  if (!occupied.has(fallback)) {
    occupied.add(fallback);
    return fallback;
  }
  let suffix = 2;
  while (occupied.has(`${fallback}-${suffix}`)) suffix++;
  const root = `${fallback}-${suffix}`;
  occupied.add(root);
  return root;
}

function regularFileWithin(root: string, file: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    return isWithin(realRoot, realFile) && fs.statSync(realFile).isFile();
  } catch {
    return false;
  }
}

function notebookSessionIds(notebookDir: string): string[] {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(notebookDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.isFile()) continue;
    const match =
      /^(.+)\.annotations\.json$/.exec(file.name) ??
      /^(.+)\.jsonl$/.exec(file.name);
    if (match && isValidSessionId(match[1])) ids.add(match[1]);
  }
  return [...ids].sort();
}

function artifactLinks(
  entries: NotebookEntry[],
  sandboxRoot: string,
): {
  href: (relPath: string) => string | undefined;
  missing: ReadonlySet<string>;
} {
  const archived = new Map<string, string>();
  const missing = new Set<string>();
  for (const entry of entries) {
    for (const artifact of entry.artifacts ?? []) {
      if (archived.has(artifact) || missing.has(artifact)) continue;
      const normalized = artifact.replaceAll("\\", "/").replace(/^\/+/, "");
      const abs = path.resolve(sandboxRoot, normalized);
      let visibleFile = false;
      try {
        visibleFile =
          isWithin(sandboxRoot, abs) &&
          isUserVisible(abs, sandboxRoot) &&
          fs.lstatSync(abs).isFile();
      } catch {
        visibleFile = false;
      }
      if (visibleFile) archived.set(artifact, apiRelative(sandboxRoot, abs));
      else missing.add(artifact);
    }
  }
  return {
    href: (artifact) => {
      const rel = archived.get(artifact);
      return rel ? `../../${rel}` : undefined;
    },
    missing,
  };
}

async function addChatHistory(
  zip: AdmZip,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): Promise<number> {
  const sessions = (opts.sessions ?? await listSessions(opts.paths))
    .filter((session) => session.messageCount > 0 && isValidSessionId(session.id));
  if (sessions.length === 0) return 0;

  const root = availableRoot("chat-history", occupiedRoots);
  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: Array<Record<string, unknown>>;
  } = {
    version: 1,
    projectId: opts.paths.id,
    projectName: opts.projectName ?? opts.paths.id,
    sessions: [],
  };
  let count = 0;
  for (const session of sessions) {
    if (!regularFileWithin(opts.paths.sessionsDir, session.path)) continue;
    const raw = `${root}/raw/${session.id}.jsonl`;
    const markdown = `${root}/markdown/${session.id}.md`;
    addLocalFile(zip, session.path, raw);
    zip.addFile(
      markdown,
      Buffer.from(toNotebook(session.path, session.id, opts.paths.sandbox), "utf-8"),
    );
    manifest.sessions.push({
      id: session.id,
      name: session.name ?? null,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
      raw,
      markdown,
    });
    count += 2;
  }
  if (manifest.sessions.length === 0) return 0;
  zip.addFile(`${root}/manifest.json`, jsonBuffer(manifest));
  return count + 1;
}

function addNotebooks(
  zip: AdmZip,
  opts: ProjectArchiveOptions,
  occupiedRoots: Set<string>,
): number {
  const sessionIds = notebookSessionIds(opts.paths.notebookDir);
  if (sessionIds.length === 0) return 0;

  const root = availableRoot("notebook", occupiedRoots);
  const entriesBySession = new Map(
    readProjectNotebooks(opts.paths.id).map((notebook) => [
      notebook.sessionId,
      notebook.entries,
    ]),
  );
  const manifest: {
    version: 1;
    projectId: string;
    projectName: string;
    sessions: Array<Record<string, unknown>>;
  } = {
    version: 1,
    projectId: opts.paths.id,
    projectName: opts.projectName ?? opts.paths.id,
    sessions: [],
  };
  let count = 0;
  for (const sessionId of sessionIds) {
    const entries = entriesBySession.get(sessionId) ?? [];
    const { doc: annotations } = readNotebookAnnotations(sessionId, opts.paths.id);
    const entryFile = path.join(opts.paths.notebookDir, `${sessionId}.jsonl`);
    const annotationsFile = path.join(
      opts.paths.notebookDir,
      `${sessionId}.annotations.json`,
    );
    const rawEntries = `${root}/raw/${sessionId}.jsonl`;
    const rawAnnotations = `${root}/raw/${sessionId}.annotations.json`;
    const markdown = `${root}/markdown/${sessionId}.md`;
    const hasRawEntries = regularFileWithin(opts.paths.notebookDir, entryFile);
    const hasRawAnnotations = regularFileWithin(
      opts.paths.notebookDir,
      annotationsFile,
    );
    if (hasRawEntries) {
      addLocalFile(zip, entryFile, rawEntries);
      count++;
    }
    if (hasRawAnnotations) {
      addLocalFile(zip, annotationsFile, rawAnnotations);
      count++;
    }
    const links = artifactLinks(entries, opts.paths.sandbox);
    zip.addFile(
      markdown,
      Buffer.from(
        notebookToMarkdown(entries, {
          sessionId,
          projectName: opts.projectName ?? opts.paths.id,
          annotations: annotations.annotations,
          artifactHref: links.href,
          missingArtifacts: links.missing,
        }),
        "utf-8",
      ),
    );
    count++;
    manifest.sessions.push({
      sessionId,
      entries,
      annotations: annotations.annotations,
      rawEntries: hasRawEntries ? rawEntries : null,
      rawAnnotations: hasRawAnnotations ? rawAnnotations : null,
      markdown,
    });
  }
  zip.addFile(`${root}/manifest.json`, jsonBuffer(manifest));
  return count + 1;
}

export async function buildProjectArchive(
  opts: ProjectArchiveOptions,
): Promise<ProjectArchiveResult> {
  const zip = new AdmZip();
  const occupiedRoots = new Set<string>();
  let entryCount = addVisibleSandboxFiles(
    zip,
    opts.paths.sandbox,
    occupiedRoots,
  );
  entryCount += await addChatHistory(zip, opts, occupiedRoots);
  entryCount += addNotebooks(zip, opts, occupiedRoots);
  return { buffer: zip.toBuffer(), entryCount };
}
