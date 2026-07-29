/**
 * Sandbox file API — TS port of kady_agent/api/sandbox.py.
 *
 * All paths are resolved through safePath() (traversal guard). Hidden/system
 * entries follow the same visibility rules as the old backend. Annotation
 * sidecars (<file>.annotations.json) are edited through dedicated endpoints and
 * cascade on move/delete. AnnData previews shell out to a small Python helper.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activePaths, getProject, touchProject } from "../projects.ts";
import { buildProjectArchive } from "../project-archive.ts";
import { artifactProvenance } from "../provenance/lookup.ts";
import { currentProjectId } from "../scope.ts";
import { apiRelative, guessMime, isUserVisible, isWithin, safePath, SandboxError } from "../sandbox-fs.ts";
import { sciHelperFor, runSciHelper, runHelperScript } from "./sci-helpers.ts";
import { LATEX_ENGINES, compileLatex } from "../latex/compile.ts";
import { synctexAvailable, synctexForward, synctexInverse } from "../latex/synctex.ts";
import { AssistError, runLatexAssist, type AssistRequest } from "../latex/assist.ts";
import {
  PdfAnnotationStoreError,
  readPdfAnnotations,
  replacePdfAnnotations,
  type PdfAnnotation,
  type PdfAnnotationsDoc,
} from "../pdf-annotations-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNDATA_HELPER = path.join(__dirname, "..", "helpers", "anndata_helper.py");
const MAX_PREVIEW_BYTES = 512_000;
const TREE_EXCLUDED_DIRS = new Set(["__pycache__", "node_modules"]);

function isTreeExcludedDir(name: string): boolean {
  return (
    TREE_EXCLUDED_DIRS.has(name) ||
    /(?:^|[-_.])(?:venv|virtualenv)$/i.test(name)
  );
}

/**
 * RFC 6266 header value.
 *
 * A `"` or a backslash in a filename closes the quoted-string early, so the
 * browser saves the file under a truncated name (or rejects the header). The
 * ASCII fallback stays quoted for old clients; `filename*` carries the real
 * name for everything else.
 */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** `report.csv` → `report (2).csv` when the destination is taken. */
function uniqueDestination(dest: string): string {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/** Rename, falling back to copy+unlink when staging landed on another device. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/**
 * Write via a temp file + rename so a crash mid-write cannot leave the
 * original truncated. Readers see either the old file or the new one.
 */
function writeFileAtomic(target: string, data: Buffer | string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  size?: number;
  children?: TreeNode[];
}

interface TreePayload {
  body: string;
  etag: string;
}

const treeBuilds = new Map<string, Promise<TreePayload>>();

async function buildTree(
  dir: string,
  sandboxRoot: string,
  depth = 0,
): Promise<TreeNode> {
  const node: TreeNode = {
    name: path.basename(dir) || "sandbox",
    type: "directory",
    path: apiRelative(sandboxRoot, dir),
    children: [],
  };
  if (depth > 8) return node;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => {
    const af = a.isFile() ? 1 : 0;
    const bf = b.isFile() ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (!isUserVisible(abs, sandboxRoot)) continue;
    const rel = apiRelative(sandboxRoot, abs);
    if (entry.isDirectory()) {
      // Dependency and interpreter caches can contain tens of thousands of
      // files and are never useful in the user-facing project browser.
      if (isTreeExcludedDir(entry.name)) continue;
      node.children!.push(await buildTree(abs, sandboxRoot, depth + 1));
    } else if (entry.isFile()) {
      // Size is optional in the wire schema and unused by the UI. Avoiding a
      // separate stat call per file makes large scientific datasets much
      // cheaper to enumerate.
      node.children!.push({ name: entry.name, type: "file", path: rel });
    }
  }
  return node;
}

async function buildTreePayload(root: string): Promise<TreePayload> {
  const tree = await buildTree(root, root);
  const body = JSON.stringify(tree);
  const digest = createHash("sha256").update(body).digest("base64url");
  return { body, etag: `"${digest}"` };
}

function buildTreeOnce(root: string): Promise<TreePayload> {
  const existing = treeBuilds.get(root);
  if (existing) return existing;

  const pending = buildTreePayload(root);
  treeBuilds.set(root, pending);
  const clear = () => {
    if (treeBuilds.get(root) === pending) treeBuilds.delete(root);
  };
  void pending.then(clear, clear);
  return pending;
}

function zipDir(root: string, base: string): { archive: ZipArchive; entryCount: number } {
  const archive = new ZipArchive({
    forceZip64: true,
    zlib: { level: 6 },
  });
  let entryCount = 0;
  archive.on("warning", (err) => archive.destroy(err));
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (!isUserVisible(abs, base)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        archive.file(abs, {
          name: apiRelative(base, abs),
          stats: fs.statSync(abs),
        });
        entryCount++;
      }
    }
  };
  walk(root);
  return { archive, entryCount };
}

function normalizeAnnotations(data: unknown): PdfAnnotationsDoc {
  if (!data || typeof data !== "object") throw new SandboxError(400, "Annotations body must be a JSON object");
  const anns = (data as { annotations?: unknown }).annotations ?? [];
  if (!Array.isArray(anns)) throw new SandboxError(400, "'annotations' must be a list");
  anns.forEach((ann, i) => {
    if (!ann || typeof ann !== "object") throw new SandboxError(400, `annotations[${i}] must be an object`);
    const a = ann as Record<string, unknown>;
    if (!a.id || typeof a.id !== "string") throw new SandboxError(400, `annotations[${i}].id is required`);
    if (a.type !== "highlight" && a.type !== "note") throw new SandboxError(400, `annotations[${i}].type invalid`);
    if (typeof a.page !== "number" || a.page < 1) throw new SandboxError(400, `annotations[${i}].page must be a positive int`);
    const author = a.author as { kind?: string } | undefined;
    if (!author || (author.kind !== "user" && author.kind !== "expert")) {
      throw new SandboxError(400, `annotations[${i}].author.kind invalid`);
    }
  });
  return { version: 1, annotations: anns as PdfAnnotation[] };
}

/** Map SandboxError → HTTP reply; rethrow others. */
function handle(reply: FastifyReply, err: unknown): { detail: string } {
  if (err instanceof SandboxError) {
    reply.code(err.statusCode);
    return { detail: err.message };
  }
  if (err instanceof PdfAnnotationStoreError) {
    const status = {
      INVALID_PATH: 403,
      NOT_FOUND: 404,
      NOT_PDF: 400,
      CONFLICT: 412,
      LOCK_TIMEOUT: 503,
    }[err.code];
    reply.code(status);
    return { detail: err.message };
  }
  reply.code(500);
  return { detail: (err as Error).message };
}

export async function registerSandboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sandbox/tree", async (req, reply) => {
    const root = activePaths().sandbox;
    const payload = fs.existsSync(root)
      ? await buildTreeOnce(root)
      : (() => {
          const body = JSON.stringify({
            name: "sandbox",
            type: "directory",
            path: "",
            children: [],
          });
          const digest = createHash("sha256").update(body).digest("base64url");
          return { body, etag: `"${digest}"` };
        })();

    reply.header("ETag", payload.etag);
    reply.header("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === payload.etag) {
      return reply.code(304).send();
    }
    return reply.type("application/json; charset=utf-8").send(payload.body);
  });

  app.post("/sandbox/upload", async (req, reply) => {
    const paths = activePaths();
    fs.mkdirSync(paths.uploadDir, { recursive: true });
    // Files stream straight to a staging dir instead of being buffered: with a
    // 1GB per-file limit, holding a whole multi-file upload in memory is an
    // easy out-of-memory kill for exactly the large datasets this is for.
    // Staging lives next to the destination so the final move is a rename.
    const stagingRoot = fs.mkdtempSync(path.join(paths.root, ".upload-"));
    // The client sends parallel `files`/`paths` parts: paths[i] is the i-th
    // file's relative subpath for folder uploads (may be empty for flat files).
    const staged: { filename: string; temp: string }[] = [];
    const relPaths: string[] = [];
    try {
      const parts = (req as FastifyRequest & { parts: () => AsyncIterable<any> }).parts();
      for await (const part of parts) {
        if (part.type === "file") {
          if (!part.filename) {
            part.file.resume();
            continue;
          }
          const temp = path.join(stagingRoot, String(staged.length));
          await pipeline(part.file, fs.createWriteStream(temp));
          if (part.file.truncated) {
            reply.code(413);
            return { detail: `${part.filename} exceeds the maximum upload size` };
          }
          staged.push({ filename: part.filename, temp });
        } else if (part.fieldname === "paths") {
          relPaths.push(String(part.value ?? ""));
        }
      }
      const saved: string[] = [];
      const renamed: { from: string; to: string }[] = [];
      for (let i = 0; i < staged.length; i++) {
        const rel = (relPaths[i] ?? "").trim();
        let dest: string;
        if (rel) {
          const safeParts = rel
            .split(/[\\/]+/)
            .filter((p) => p && p !== "." && p !== ".." && !p.startsWith("."));
          if (!safeParts.length) continue;
          dest = path.join(paths.uploadDir, ...safeParts);
        } else {
          const safeName = path.basename(staged[i].filename);
          if (!safeName || safeName.startsWith(".")) continue;
          dest = path.join(paths.uploadDir, safeName);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // Re-uploading a name that already exists used to destroy the original
        // with no warning. Park the new copy beside it instead.
        const finalDest = uniqueDestination(dest);
        moveFile(staged[i].temp, finalDest);
        if (finalDest !== dest) {
          renamed.push({
            from: apiRelative(paths.sandbox, dest),
            to: apiRelative(paths.sandbox, finalDest),
          });
        }
        saved.push(apiRelative(paths.sandbox, finalDest));
      }
      touchProject(currentProjectId());
      return { uploaded: saved, renamed };
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  app.get<{ Querystring: { path: string } }>("/sandbox/file", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404);
        return "File not found";
      }
      if (fs.statSync(target).size > MAX_PREVIEW_BYTES) {
        reply.code(413);
        return "File too large to preview";
      }
      reply.type("text/plain; charset=utf-8");
      return fs.readFileSync(target, "utf-8");
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.put<{ Querystring: { path: string }; Body: Buffer }>("/sandbox/file", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = req.body instanceof Buffer ? req.body : Buffer.from(String(req.body ?? ""));
      writeFileAtomic(target, body);
      touchProject(currentProjectId());
      return { saved: req.query.path, size: body.length };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.delete<{ Querystring: { path: string } }>("/sandbox/file", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      fs.rmSync(target);
      const sidecar = target + ".annotations.json";
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
      touchProject(currentProjectId());
      return { deleted: req.query.path };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.delete<{ Querystring: { path: string } }>("/sandbox/directory", async (req, reply) => {
    try {
      const root = activePaths().sandbox;
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        reply.code(404);
        return { detail: "Directory not found" };
      }
      if (target === root) {
        reply.code(403);
        return { detail: "Cannot delete sandbox root" };
      }
      fs.rmSync(target, { recursive: true, force: true });
      touchProject(currentProjectId());
      return { deleted: req.query.path };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post<{ Body: { src: string; dest: string } }>("/sandbox/move", async (req, reply) => {
    try {
      const { src, dest } = req.body;
      const srcPath = safePath(src);
      const destPath = safePath(dest);
      if (!fs.existsSync(srcPath)) {
        reply.code(404);
        return { detail: "Source not found" };
      }
      if (fs.existsSync(destPath)) {
        reply.code(409);
        return { detail: "Destination already exists" };
      }
      if (!fs.existsSync(path.dirname(destPath))) {
        reply.code(404);
        return { detail: "Destination parent directory not found" };
      }
      if (fs.statSync(srcPath).isDirectory() && isWithin(srcPath, destPath)) {
        reply.code(400);
        return { detail: "Cannot move a directory into itself" };
      }
      fs.renameSync(srcPath, destPath);
      const srcSidecar = srcPath + ".annotations.json";
      if (fs.existsSync(srcSidecar)) {
        const destSidecar = destPath + ".annotations.json";
        if (!fs.existsSync(destSidecar)) {
          try {
            fs.renameSync(srcSidecar, destSidecar);
          } catch {
            /* best-effort */
          }
        }
      }
      touchProject(currentProjectId());
      return { ok: true };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post<{ Body: { path: string } }>("/sandbox/mkdir", async (req, reply) => {
    try {
      const target = safePath(req.body.path);
      if (fs.existsSync(target)) {
        reply.code(409);
        return { detail: "Path already exists" };
      }
      if (!fs.existsSync(path.dirname(target))) {
        reply.code(404);
        return { detail: "Parent directory not found" };
      }
      fs.mkdirSync(target);
      touchProject(currentProjectId());
      return { ok: true };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string } }>("/sandbox/raw", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (!stat?.isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      reply.type(guessMime(path.basename(target)));
      reply.header("Content-Disposition", contentDisposition("inline", path.basename(target)));
      // Streams are sent chunked by default. Viewers that refuse to load a
      // huge file need the size up front, before the body arrives.
      reply.header("Content-Length", stat.size);
      return reply.send(fs.createReadStream(target));
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string } }>("/sandbox/download", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (!stat?.isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      reply.type("application/octet-stream");
      reply.header("Content-Disposition", contentDisposition("attachment", path.basename(target)));
      reply.header("Content-Length", stat.size);
      return reply.send(fs.createReadStream(target));
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string } }>("/sandbox/download-dir", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        reply.code(404);
        return { detail: "Directory not found" };
      }
      const { archive, entryCount } = zipDir(target, target);
      if (entryCount === 0) {
        archive.abort();
        reply.code(404);
        return { detail: "Directory is empty" };
      }
      reply.type("application/zip");
      reply.header(
        "Content-Disposition",
        contentDisposition("attachment", `${path.basename(target)}.zip`),
      );
      const response = reply.send(archive);
      // Archiver emits the same failure on the stream, which Fastify handles.
      void archive.finalize().catch(() => undefined);
      return response;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get("/sandbox/download-all", async (_req, reply) => {
    const projectId = currentProjectId();
    const paths = activePaths();
    const { archive, entryCount } = await buildProjectArchive({
      paths,
      projectName: getProject(projectId)?.name ?? projectId,
    });
    if (entryCount === 0) {
      archive.abort();
      reply.code(404);
      return { detail: "No files to download" };
    }
    reply.type("application/zip");
    reply.header("Content-Disposition", 'attachment; filename="sandbox.zip"');
    const response = reply.send(archive);
    void archive.finalize().catch(() => undefined);
    return response;
  });

  // --- annotations ---
  app.get<{ Querystring: { path: string } }>("/sandbox/annotations", async (req, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const result = readPdfAnnotations(activePaths().sandbox, req.query.path);
      if (result.mtime) reply.header("Last-Modified", result.mtime.toUTCString());
      if (result.etag) reply.header("ETag", result.etag);
      return result.doc;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.put<{ Querystring: { path: string }; Body: unknown }>("/sandbox/annotations", async (req, reply) => {
    try {
      const doc = normalizeAnnotations(req.body);
      const saved = await replacePdfAnnotations(activePaths().sandbox, req.query.path, doc, {
        // If-Match is the precise check; If-Unmodified-Since stays as a
        // fallback for clients that only kept the Last-Modified value.
        etag: req.headers["if-match"] ? String(req.headers["if-match"]) : null,
        ifUnmodifiedSince: req.headers["if-unmodified-since"]
          ? String(req.headers["if-unmodified-since"])
          : null,
      });
      touchProject(currentProjectId());
      reply.header("Last-Modified", saved.mtime.toUTCString());
      if (saved.etag) reply.header("ETag", saved.etag);
      return { saved: req.query.path, count: doc.annotations.length };
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- provenance ---
  app.get<{ Querystring: { path: string } }>("/sandbox/provenance", async (req, reply) => {
    try {
      const rel = req.query.path;
      if (!rel) {
        reply.code(400);
        return { detail: "path is required" };
      }
      // safePath enforces the traversal/symlink guard; artifactProvenance
      // re-derives the sandbox-relative form it indexes by.
      safePath(rel);
      reply.header("Cache-Control", "no-store");
      return artifactProvenance(currentProjectId(), rel);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- anndata (.h5ad) via Python helper ---
  app.get<{ Querystring: { path: string } }>("/sandbox/anndata-summary", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !target.toLowerCase().endsWith(".h5ad")) {
        reply.code(400);
        return { detail: "Not a .h5ad file" };
      }
      const res = await runHelperScript(ANNDATA_HELPER, ["summarize", target]);
      if (res.timedOut) {
        reply.code(504);
        return { detail: res.stderr.trim() };
      }
      if (res.status === 3) {
        reply.code(503);
        return { detail: res.stderr.trim() || "AnnData deps missing" };
      }
      if (res.status !== 0) {
        reply.code(500);
        return { detail: res.stderr.trim() || "Failed to read h5ad" };
      }
      reply.type("application/json");
      return res.stdout;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string; key: string; color?: string } }>(
    "/sandbox/anndata-embedding.png",
    async (req, reply) => {
      try {
        const target = safePath(req.query.path);
        if (!fs.existsSync(target) || !target.toLowerCase().endsWith(".h5ad")) {
          reply.code(400);
          return { detail: "Not a .h5ad file" };
        }
        const cacheDir = path.join(activePaths().root, ".anndata_cache");
        const outPng = path.join(os.tmpdir(), `kady-emb-${process.pid}-${Date.now()}.png`);
        try {
          const res = await runHelperScript(ANNDATA_HELPER, [
            "embedding",
            target,
            req.query.key,
            req.query.color || "-",
            cacheDir,
            outPng,
          ]);
          if (res.timedOut) {
            reply.code(504);
            return { detail: res.stderr.trim() };
          }
          if (res.status === 3) {
            reply.code(503);
            return { detail: res.stderr.trim() || "AnnData deps missing" };
          }
          if (res.status === 4) {
            reply.code(404);
            return { detail: res.stderr.trim() };
          }
          if (res.status === 5) {
            reply.code(400);
            return { detail: res.stderr.trim() };
          }
          if (res.status !== 0 || !fs.existsSync(outPng)) {
            reply.code(500);
            return { detail: res.stderr.trim() || "Failed to render embedding" };
          }
          const data = fs.readFileSync(outPng);
          reply.type("image/png");
          reply.header("Cache-Control", "private, max-age=300");
          return data;
        } finally {
          // Every failure path can leave a partial render behind; the success
          // path used to be the only one that cleaned up.
          fs.rmSync(outPng, { force: true });
        }
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  // --- generic scientific-file previews (chem/structure/...) via Python helper ---
  app.get<{ Querystring: { path: string; kind: string } }>("/sandbox/sci-summary", async (req, reply) => {
    try {
      if (!sciHelperFor(req.query.kind)) {
        reply.code(400);
        return { detail: `Unknown kind: ${req.query.kind}` };
      }
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      const res = await runSciHelper(req.query.kind, "summarize", [target]);
      if (res.timedOut) {
        reply.code(504);
        return { detail: res.stderr.trim() };
      }
      if (res.status === 3) {
        reply.code(503);
        return { detail: res.stderr.trim() || "Preview dependency missing" };
      }
      if (res.status === 4) {
        reply.code(404);
        return { detail: res.stderr.trim() };
      }
      if (res.status === 5) {
        reply.code(400);
        return { detail: res.stderr.trim() };
      }
      if (res.status !== 0) {
        reply.code(500);
        return { detail: res.stderr.trim() || "Failed to summarize" };
      }
      reply.type("application/json");
      return res.stdout;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string; kind: string; index?: string; axis?: string } }>(
    "/sandbox/sci-render.png",
    async (req, reply) => {
      try {
        if (!sciHelperFor(req.query.kind)) {
          reply.code(400);
          return { detail: `Unknown kind: ${req.query.kind}` };
        }
        const target = safePath(req.query.path);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          reply.code(404);
          return { detail: "File not found" };
        }
        const outPath = path.join(os.tmpdir(), `kady-sci-${process.pid}-${Date.now()}`);
        try {
          const res = await runSciHelper(req.query.kind, "render", [
            target,
            req.query.index ?? "0",
            outPath,
            req.query.axis ?? "-",
          ]);
          if (res.timedOut) {
            reply.code(504);
            return { detail: res.stderr.trim() };
          }
          if (res.status === 3) {
            reply.code(503);
            return { detail: res.stderr.trim() || "Preview dependency missing" };
          }
          if (res.status === 4) {
            reply.code(404);
            return { detail: res.stderr.trim() };
          }
          if (res.status === 5) {
            reply.code(400);
            return { detail: res.stderr.trim() };
          }
          if (res.status !== 0 || !fs.existsSync(outPath)) {
            reply.code(500);
            return { detail: res.stderr.trim() || "Failed to render" };
          }
          const data = fs.readFileSync(outPath);
          // helper writes SVG for chem 2D, PNG otherwise; sniff the first byte
          reply.type(data.slice(0, 5).toString("utf-8").startsWith("<") ? "image/svg+xml" : "image/png");
          reply.header("Cache-Control", "private, max-age=300");
          return data;
        } finally {
          fs.rmSync(outPath, { force: true });
        }
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  // --- LaTeX compile ---
  app.post<{ Body: { path?: string; engine?: string } }>("/sandbox/compile-latex", async (req, reply) => {
    try {
      const engine = req.body.engine || "pdflatex";
      if (!LATEX_ENGINES.has(engine)) {
        reply.code(400);
        return { detail: `Unsupported engine: ${engine}` };
      }
      const target = safePath(req.body.path || "");
      if (!fs.existsSync(target) || !/\.(tex|latex)$/.test(target)) {
        reply.code(400);
        return { detail: "Not a .tex file" };
      }
      // Abort the engine passes if the client goes away (tab closed, navigated
      // off); a full compile can otherwise keep a core busy for a minute for
      // a result nobody will read.
      const cancel = new AbortController();
      req.raw.on("close", () => {
        if (!req.raw.readableEnded) cancel.abort();
      });
      return await compileLatex(target, engine, activePaths().sandbox, {
        signal: cancel.signal,
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- SyncTeX source<->PDF mapping ---
  app.get<{
    Querystring: {
      dir?: string; path?: string; pdf?: string;
      line?: string; col?: string; page?: string; x?: string; y?: string;
    };
  }>("/sandbox/synctex", async (req, reply) => {
    try {
      if (!synctexAvailable()) {
        reply.code(424);
        return { detail: "synctex-unavailable" };
      }
      const q = req.query;
      const pdfAbs = safePath(q.pdf || "");
      if (!fs.existsSync(pdfAbs)) {
        reply.code(404);
        return { detail: "no-result" };
      }
      if (q.dir === "forward") {
        const texAbs = safePath(q.path || "");
        const line = parseInt(q.line || "", 10);
        const col = parseInt(q.col || "0", 10) || 0;
        if (!fs.existsSync(texAbs) || !Number.isFinite(line)) {
          reply.code(400);
          return { detail: "Bad forward-sync request" };
        }
        const box = await synctexForward(texAbs, line, col, pdfAbs);
        if (!box) {
          reply.code(404);
          return { detail: "no-result" };
        }
        return box;
      }
      if (q.dir === "inverse") {
        const page = parseInt(q.page || "", 10);
        const x = parseFloat(q.x || "");
        const y = parseFloat(q.y || "");
        if (![page, x, y].every(Number.isFinite)) {
          reply.code(400);
          return { detail: "Bad inverse-sync request" };
        }
        const loc = await synctexInverse(pdfAbs, page, x, y);
        if (!loc) {
          reply.code(404);
          return { detail: "no-result" };
        }
        const root = activePaths().sandbox;
        // synctex Input records may be relative to the build directory —
        // resolve against the PDF's directory, not the server process cwd.
        const abs = path.resolve(path.dirname(pdfAbs), loc.file);
        const rel = apiRelative(root, abs);
        // Outside the sandbox → null. The isAbsolute check matters on
        // Windows: path.relative across drives (sandbox on D:, TeX on C:)
        // returns the absolute target with no ".." prefix.
        const outside = rel.startsWith("..") || path.isAbsolute(rel);
        return {
          file: outside ? null : rel,
          line: loc.line,
          column: loc.column,
        };
      }
      reply.code(400);
      return { detail: "dir must be forward or inverse" };
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- AI assist (fix error / rewrite selection) ---
  app.post<{ Body: AssistRequest }>("/sandbox/latex-assist", async (req, reply) => {
    try {
      const projectId = currentProjectId();
      return await runLatexAssist(req.body, projectId);
    } catch (err) {
      if (err instanceof AssistError) {
        reply.code(err.status);
        return { detail: err.status === 402 ? "budget-exceeded" : "assist-failed", message: err.message };
      }
      return handle(reply, err);
    }
  });
}
