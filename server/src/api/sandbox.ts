/**
 * Sandbox file API — TS port of kady_agent/api/sandbox.py.
 *
 * All paths are resolved through safePath() (traversal guard). Hidden/system
 * entries follow the same visibility rules as the old backend. Annotation
 * sidecars (<file>.annotations.json) are edited through dedicated endpoints and
 * cascade on move/delete. AnnData previews shell out to a small Python helper.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activePaths, touchProject } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import {
  guessMime,
  isUserVisible,
  safePath,
  SandboxError,
  USER_HIDDEN_NAMES,
} from "../sandbox-fs.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNDATA_HELPER = path.join(__dirname, "..", "helpers", "anndata_helper.py");
const PYTHON = process.env.KADY_PYTHON || "python3";
const MAX_PREVIEW_BYTES = 512_000;
const VALID_ENGINES = new Set(["pdflatex", "xelatex", "lualatex"]);

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  size?: number;
  children?: TreeNode[];
}

function buildTree(dir: string, sandboxRoot: string, depth = 0): TreeNode {
  const node: TreeNode = {
    name: path.basename(dir) || "sandbox",
    type: "directory",
    path: path.relative(sandboxRoot, dir),
    children: [],
  };
  if (depth > 8) return node;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
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
    const rel = path.relative(sandboxRoot, abs);
    if (entry.isDirectory()) {
      node.children!.push(buildTree(abs, sandboxRoot, depth + 1));
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        /* ignore */
      }
      node.children!.push({ name: entry.name, type: "file", path: rel, size });
    }
  }
  return node;
}

function zipDir(root: string, base: string): Buffer {
  const zip = new AdmZip();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep).some((p) => p.startsWith("."))) continue;
      if (USER_HIDDEN_NAMES.has(entry.name)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) zip.addLocalFile(abs, path.dirname(rel));
    }
  };
  walk(root);
  return zip.toBuffer();
}

function sidecarFor(pdfRel: string): string {
  const target = safePath(pdfRel);
  if (target.endsWith(".annotations.json")) {
    throw new SandboxError(400, "Refusing to annotate a sidecar");
  }
  return target + ".annotations.json";
}

function normalizeAnnotations(data: unknown): { version: number; annotations: unknown[] } {
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
  return { version: 1, annotations: anns };
}

/** Map SandboxError → HTTP reply; rethrow others. */
function handle(reply: FastifyReply, err: unknown): { detail: string } {
  if (err instanceof SandboxError) {
    reply.code(err.statusCode);
    return { detail: err.message };
  }
  reply.code(500);
  return { detail: (err as Error).message };
}

export async function registerSandboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sandbox/tree", async () => {
    const root = activePaths().sandbox;
    if (!fs.existsSync(root)) return { name: "sandbox", type: "directory", path: "", children: [] };
    return buildTree(root, root);
  });

  app.post("/sandbox/upload", async (req, reply) => {
    const paths = activePaths();
    fs.mkdirSync(paths.uploadDir, { recursive: true });
    const saved: string[] = [];
    const parts = (req as FastifyRequest & { parts: () => AsyncIterable<any> }).parts();
    for await (const part of parts) {
      if (part.type !== "file" || !part.filename) continue;
      const safeName = path.basename(part.filename);
      if (!safeName || safeName.startsWith(".")) {
        part.file.resume();
        continue;
      }
      const dest = path.join(paths.uploadDir, safeName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = await part.toBuffer();
      fs.writeFileSync(dest, buf);
      saved.push(path.relative(paths.sandbox, dest));
    }
    touchProject(currentProjectId());
    return { uploaded: saved };
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
      fs.writeFileSync(target, body);
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
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      reply.type(guessMime(path.basename(target)));
      reply.header("Content-Disposition", `inline; filename="${path.basename(target)}"`);
      return fs.readFileSync(target);
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get<{ Querystring: { path: string } }>("/sandbox/download", async (req, reply) => {
    try {
      const target = safePath(req.query.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404);
        return { detail: "File not found" };
      }
      reply.type("application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${path.basename(target)}"`);
      return fs.readFileSync(target);
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
      const buf = zipDir(target, target);
      if (buf.length <= 22) {
        reply.code(404);
        return { detail: "Directory is empty" };
      }
      reply.type("application/zip");
      reply.header("Content-Disposition", `attachment; filename="${path.basename(target)}.zip"`);
      return buf;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get("/sandbox/download-all", async (_req, reply) => {
    const root = activePaths().sandbox;
    if (!fs.existsSync(root)) {
      reply.code(404);
      return { detail: "Sandbox is empty" };
    }
    const buf = zipDir(root, root);
    if (buf.length <= 22) {
      reply.code(404);
      return { detail: "No files to download" };
    }
    reply.type("application/zip");
    reply.header("Content-Disposition", 'attachment; filename="sandbox.zip"');
    return buf;
  });

  // --- annotations ---
  app.get<{ Querystring: { path: string } }>("/sandbox/annotations", async (req, reply) => {
    try {
      const sidecar = sidecarFor(req.query.path);
      reply.header("Cache-Control", "no-store");
      if (!fs.existsSync(sidecar)) return { version: 1, annotations: [] };
      const raw = fs.readFileSync(sidecar, "utf-8");
      const data = raw.trim() ? JSON.parse(raw) : { version: 1, annotations: [] };
      reply.header("Last-Modified", fs.statSync(sidecar).mtime.toUTCString());
      return data;
    } catch (err) {
      if (err instanceof SyntaxError) return { version: 1, annotations: [] };
      return handle(reply, err);
    }
  });

  app.put<{ Querystring: { path: string }; Body: unknown }>("/sandbox/annotations", async (req, reply) => {
    try {
      const sidecar = sidecarFor(req.query.path);
      if (fs.existsSync(sidecar)) {
        const precond = req.headers["if-unmodified-since"];
        if (precond) {
          const expected = new Date(String(precond)).getTime();
          const actual = fs.statSync(sidecar).mtime.getTime();
          if (!Number.isNaN(expected) && actual - expected > 1000) {
            reply.code(412);
            return { detail: "Sidecar modified; re-read and retry" };
          }
        }
      }
      const doc = normalizeAnnotations(req.body);
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      const tmp = sidecar + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, sidecar);
      touchProject(currentProjectId());
      reply.header("Last-Modified", fs.statSync(sidecar).mtime.toUTCString());
      return { saved: req.query.path, count: doc.annotations.length };
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
      const res = spawnSync(PYTHON, [ANNDATA_HELPER, "summarize", target], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
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
        const res = spawnSync(
          PYTHON,
          [ANNDATA_HELPER, "embedding", target, req.query.key, req.query.color || "-", cacheDir, outPng],
          { encoding: "utf-8" },
        );
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
        fs.rmSync(outPng, { force: true });
        reply.type("image/png");
        reply.header("Cache-Control", "private, max-age=300");
        return data;
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  // --- LaTeX compile ---
  app.post<{ Body: { path?: string; engine?: string } }>("/sandbox/compile-latex", async (req, reply) => {
    try {
      const engine = req.body.engine || "pdflatex";
      if (!VALID_ENGINES.has(engine)) {
        reply.code(400);
        return { detail: `Unsupported engine: ${engine}` };
      }
      const target = safePath(req.body.path || "");
      if (!fs.existsSync(target) || !/\.(tex|latex)$/.test(target)) {
        reply.code(400);
        return { detail: "Not a .tex file" };
      }
      const workDir = path.dirname(target);
      const stem = path.basename(target).replace(/\.(tex|latex)$/, "");
      const pdfPath = path.join(workDir, stem + ".pdf");
      const hasLatexmk = spawnSync("which", ["latexmk"]).status === 0;
      const cmd = hasLatexmk
        ? ["latexmk", `-${engine}`, "-interaction=nonstopmode", "-cd", "-file-line-error", target]
        : [engine, "-interaction=nonstopmode", "-file-line-error", path.basename(target)];
      const res = spawnSync(cmd[0], cmd.slice(1), {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        return { success: false, pdf_path: null, log: "Compilation timed out after 60 seconds.", errors: ["Timeout"] };
      }
      if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, pdf_path: null, log: `LaTeX compiler not found. Install TeX Live or add ${engine} to PATH.`, errors: [`${engine} not found`] };
      }
      const log = `${res.stdout || ""}${res.stderr || ""}`;
      const errors = [...log.matchAll(/^! (.+)/gm)].map((m) => m[1]);
      const success = res.status === 0 && fs.existsSync(pdfPath);
      const root = activePaths().sandbox;
      return {
        success,
        pdf_path: fs.existsSync(pdfPath) ? path.relative(root, pdfPath) : null,
        log: log.length > 8000 ? log.slice(-8000) : log,
        errors,
      };
    } catch (err) {
      return handle(reply, err);
    }
  });
}
