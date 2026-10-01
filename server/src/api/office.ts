/** Office snapshots and conflict-checked, atomic, provenance-recorded edits. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { HELPERS_DIR } from "../helpers-env.ts";
import { activePaths, touchProject } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import { guessMime, safePath, SandboxError } from "../sandbox-fs.ts";
import { priorIdentity, recordSave } from "../provenance/user-steps.ts";
import { runHelperScript } from "./sci-helpers.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const helper = path.join(HELPERS_DIR, "office_helper.py");
let operations = 0;
const saves = new Set<string>();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function kindOf(target: string): string {
  const kind = path.extname(target).slice(1).toLowerCase();
  if (!["docx", "pptx", "xlsx"].includes(kind)) throw new SandboxError(400, "Supported Office formats: DOCX, PPTX, XLSX");
  return kind;
}

async function readBounded(target: string): Promise<Buffer> {
  const file = await fs.promises.open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SandboxError(400, "Select an Office file");
    if (stat.size > MAX_BYTES) throw new SandboxError(413, "Office files are limited to 32 MiB");
    const buf = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let size = 0;
    while (size < buf.length) {
      const { bytesRead } = await file.read(buf, size, buf.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await fs.promises.stat(target);
    if (stat.dev !== after.dev || stat.ino !== after.ino || size !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new SandboxError(409, "The file changed while loading. Reload it and try again.");
    }
    return buf.subarray(0, size);
  } finally { await file.close(); }
}

async function run(args: string[]) {
  const result = await runHelperScript(helper, args);
  if (result.status !== 0) {
    const missing = /No module named/.test(result.stderr);
    throw new SandboxError(missing ? 503 : result.status === 5 ? 422 : 500,
      missing ? "Office preview dependencies are unavailable. Restart Kady to finish helper setup." : result.stderr || "Office document processing failed");
  }
  return JSON.parse(result.stdout);
}

type Query = { path: string; sheet?: string; row?: string; col?: string };
function selection(query: Query) {
  const opts: Record<string, string | number> = {};
  if (query.sheet !== undefined) {
    if (query.sheet.length > 128 || query.sheet.includes("\0")) throw new SandboxError(400, "Invalid sheet name");
    opts.sheet = query.sheet;
  }
  for (const key of ["row", "col"] as const) {
    if (query[key] !== undefined) {
      const n = Number(query[key]);
      if (!Number.isInteger(n) || n < 1 || n > (key === "row" ? 1048576 : 16384)) throw new SandboxError(400, "Invalid worksheet window");
      opts[key] = n;
    }
  }
  return opts;
}

export async function registerOfficeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Query }>("/sandbox/office/content", async (req, reply) => {
    if (operations >= 4) return reply.code(429).send({ detail: "Office processing is busy. Try again shortly." });
    operations++;
    let dir: string | undefined;
    try {
      if (typeof req.query.path !== "string") throw new SandboxError(400, "A file path is required");
      const target = safePath(req.query.path), kind = kindOf(target), bytes = await readBounded(target);
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kady-office-"));
      const input = path.join(dir, `input.${kind}`);
      await fs.promises.writeFile(input, bytes);
      const model = await run(["validate", input, kind]);
      return reply.header("Cache-Control", "no-store").header("X-Content-SHA256", digest(bytes))
        .header("X-Office-Read-Only", String(model.readOnly)).type(guessMime(target)).send(bytes);
    } catch (err) { return failure(reply, err); }
    finally { operations--; if (dir) await fs.promises.rm(dir, { recursive: true, force: true }); }
  });

  app.put<{ Querystring: Query; Body: Buffer }>("/sandbox/office/content", { bodyLimit: MAX_BYTES }, async (req, reply) => {
    if (operations >= 4) return reply.code(429).send({ detail: "Office processing is busy. Try again shortly." });
    operations++;
    let dir: string | undefined, locked: string | undefined, staging: string | undefined;
    try {
      if (typeof req.query.path !== "string") throw new SandboxError(400, "A file path is required");
      const target = safePath(req.query.path), kind = kindOf(target);
      const revision = req.headers["if-match"];
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || !Buffer.isBuffer(req.body)) {
        throw new SandboxError(400, "Send Office bytes with their original revision in If-Match");
      }
      const canonical = await fs.promises.realpath(target);
      if (saves.has(canonical)) throw new SandboxError(409, "Another save is in progress. Try again.");
      saves.add(canonical); locked = canonical;
      const bytes = await readBounded(target);
      if (digest(bytes) !== revision) throw new SandboxError(409, "This file changed outside the editor. Download your edited copy before reloading; the project file has not been overwritten.");
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kady-office-"));
      const input = path.join(dir, `input.${kind}`), output = path.join(dir, `output.${kind}`);
      await fs.promises.writeFile(input, bytes);
      const original = await run(["validate", input, kind]);
      if (original.readOnly) throw new SandboxError(403, "Protected or signed documents cannot be overwritten");
      await fs.promises.writeFile(output, req.body);
      await run(["validate", output, kind]);
      const root = activePaths().sandbox, projectId = currentProjectId(), before = await priorIdentity(root, target);
      safePath(req.query.path);
      staging = path.join(path.dirname(target), `.office-${randomUUID()}.tmp`);
      await fs.promises.writeFile(staging, req.body, { flag: "wx", mode: (await fs.promises.stat(target)).mode });
      if (digest(await readBounded(safePath(req.query.path))) !== revision) throw new SandboxError(409, "This file changed during saving. Download your edited copy before reloading.");
      safePath(req.query.path); fs.renameSync(staging, target); staging = undefined;
      touchProject(projectId);
      await recordSave(projectId, root, target, before, err => req.log.warn({ err }, "failed to record Office save"));
      return { saved: req.query.path, revision: digest(req.body) };
    } catch (err) { return failure(reply, err); }
    finally {
      operations--;
      if (locked) saves.delete(locked);
      if (staging) await fs.promises.rm(staging, { force: true });
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  app.get<{ Querystring: Query }>("/sandbox/office", async (req, reply) => {
    if (operations >= 4) return reply.code(429).send({ detail: "Office processing is busy. Try again shortly." });
    operations++;
    let dir: string | undefined;
    try {
      if (typeof req.query.path !== "string") throw new SandboxError(400, "A file path is required");
      const target = safePath(req.query.path);
      const kind = kindOf(target);
      const opts = selection(req.query);
      const bytes = await readBounded(target);
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kady-office-"));
      const input = path.join(dir, `input.${kind}`);
      await fs.promises.writeFile(input, bytes);
      const model = await run(["inspect", input, kind, JSON.stringify(opts)]);
      reply.header("Cache-Control", "no-store");
      return { ...model, revision: digest(bytes), ...(kind !== "xlsx" ? { data: bytes.toString("base64") } : {}) };
    } catch (err) { return failure(reply, err); }
    finally { operations--; if (dir) await fs.promises.rm(dir, { recursive: true, force: true }); }
  });


}

function failure(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof SandboxError) return reply.code(err.statusCode).send({ detail: err.message });
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ detail: "Office file not found" });
  throw err;
}
