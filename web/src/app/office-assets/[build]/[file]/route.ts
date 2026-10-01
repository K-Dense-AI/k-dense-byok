import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { OFFICE_ASSETS, OFFICE_BUILD } from "@/lib/office-assets";
export const runtime = "nodejs";
const pending = new Map<string, Promise<string>>();
const verified = new Map<string, string>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function asset(name: string): Promise<string> {
  const root = process.env.KADY_OFFICE_ASSETS_DIR || path.join(os.homedir(), ".kady", "office-assets", OFFICE_BUILD);
  const file = path.join(root, name), spec = OFFICE_ASSETS[name];
  await fs.promises.mkdir(root, { recursive: true });
  try {
    const stat = await fs.promises.stat(file);
    const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (verified.get(file) === version) return file;
    const bytes = await fs.promises.readFile(file);
    if (hash(bytes) === spec.sha256) { verified.set(file, version); return file; }
  } catch { /* First open populates the cache. */ }
  const response = await fetch(`https://cdn.zetaoffice.net/zetaoffice_latest/${name}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error("Could not download the Office editor. Check your connection and retry.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > (spec.size || 1_000_000) + 1024) throw new Error("Unexpected Office runtime size");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== spec.sha256) throw new Error("The Office runtime download differs from the tested version. Update Kady or retry later.");
  const staging = `${file}.${randomUUID()}.tmp`;
  try { await fs.promises.writeFile(staging, bytes); await fs.promises.rename(staging, file); }
  finally { await fs.promises.rm(staging, { force: true }); }
  return file;
}

export async function GET(_request: Request, context: { params: Promise<{ build: string; file: string }> }) {
  const params = await context.params;
  if (params.build !== OFFICE_BUILD || !Object.hasOwn(OFFICE_ASSETS, params.file)) return new Response("Not found", { status: 404 });
  let job = pending.get(params.file);
  if (!job) { job = asset(params.file); pending.set(params.file, job); void job.finally(() => pending.delete(params.file)).catch(() => {}); }
  try {
    const file = await job;
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: {
      "Content-Type": OFFICE_ASSETS[params.file].type, "Content-Length": String(fs.statSync(file).size),
      "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return new Response(e instanceof Error ? e.message : "Office runtime unavailable", { status: 503 }); }
}
