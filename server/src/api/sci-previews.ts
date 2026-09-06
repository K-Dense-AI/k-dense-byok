import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyReply } from "fastify";
import { HELPERS_DIR, helperPython } from "../helpers-env.ts";
import { PreviewCache } from "../preview-cache.ts";
import { runHelperScript, type HelperResult } from "./sci-helpers.ts";

interface PreviewResult extends HelperResult {
  data?: Buffer;
  unchanged: boolean;
}
interface PreviewRequest {
  projectId: string;
  target: string;
  script: string;
  command: "summarize" | "render" | "embedding";
  params?: string[];
  cacheDir?: string;
}

const previews = new PreviewCache<PreviewResult>({
  concurrency: 2,
  maxBytes: 16 * 1024 * 1024,
  maxEntries: 64,
  ttlMs: 300_000,
  size: (result) => Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) + (result.data?.length ?? 0),
  cacheable: (result) => result.status === 0 && result.unchanged,
});

async function fileVersion(file: string): Promise<string> {
  const stat = await fs.stat(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function version(request: PreviewRequest): Promise<string> {
  // No dataset hashing/loading to validate a hit. ctime catches same-sized
  // writes with restored mtimes; inode catches atomic replacement.
  return JSON.stringify(await Promise.all([
    fileVersion(request.target),
    fileVersion(request.script),
    ...[helperPython(), path.join(HELPERS_DIR, "pyproject.toml"), path.join(HELPERS_DIR, ".venv", "pyvenv.cfg"), path.join(HELPERS_DIR, "uv.lock")]
      .map((file) => fileVersion(file).catch(() => "missing")),
  ]));
}

export async function getPreview(request: PreviewRequest, signal?: AbortSignal): Promise<PreviewResult> {
  const before = await version(request);
  const key = JSON.stringify([request, before]);
  return previews.get(key, async (workSignal) => {
    const dir = request.command === "summarize" ? null : await fs.mkdtemp(path.join(os.tmpdir(), "kady-preview-"));
    try {
      const output = dir ? path.join(dir, "image") : "";
      const params = request.params ?? [];
      const args = request.command === "summarize" ? ["summarize", request.target]
        : request.command === "render" ? ["render", request.target, params[0] ?? "0", output, params[1] ?? "-"]
        : ["embedding", request.target, params[0], params[1] ?? "-", request.cacheDir!, output];
      const result = await runHelperScript(request.script, args, undefined, workSignal);
      let data: Buffer | undefined;
      if (output && result.status === 0) {
        try { data = await fs.readFile(output); }
        catch { return { ...result, status: 1, stderr: "Preview helper produced no image", unchanged: false }; }
      }
      return { ...result, data, unchanged: before === await version(request).catch(() => "changed") };
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }, signal);
}

/** Response close, not request close: a GET request body finishes immediately. */
export async function requestPreview(reply: FastifyReply, request: PreviewRequest): Promise<PreviewResult> {
  const controller = new AbortController();
  const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
  reply.raw.on("close", onClose);
  if (reply.raw.destroyed) controller.abort();
  try { return await getPreview(request, controller.signal); }
  finally { reply.raw.removeListener("close", onClose); }
}
