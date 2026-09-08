import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { bytesHash, EvidencePackageError, PACKAGE_BYTES, ZIP_BYTES, verifiedEvidenceStream } from "./storage.ts";
export interface PackageFile { path: string; sha256: string; size: number }
export class EvidenceBuilder {
  readonly files = new Map<string, PackageFile>();
  totalBytes = 0;
  constructor(readonly root: string) {}
  private check(name: string, size: number) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.split("/").some((p) => p === ".." || !p) || this.files.has(name)) throw new Error("Invalid/duplicate generated package filename");
    if (this.files.size >= 512 || this.totalBytes + size > PACKAGE_BYTES) throw new EvidencePackageError("PACKAGE_LIMIT", "Package exceeds 512 files or 256 MiB; select fewer roots or exclude artifact bytes", 413);
  }
  async write(name: string, data: string | Buffer): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"); this.check(name, bytes.length);
    const target = path.join(this.root, name); await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    this.files.set(name, { path: name, sha256: bytesHash(bytes), size: bytes.length }); this.totalBytes += bytes.length;
  }
  async json(name: string, value: unknown): Promise<void> { await this.write(name, JSON.stringify(value, null, 2) + "\n"); }
  async artifact(name: string, source: string, sha256: string, size: number): Promise<void> {
    if (this.files.has(name)) return;
    this.check(name, size);
    // Keep space for final manifests, integrity metadata and the report.
    if (this.totalBytes + size > PACKAGE_BYTES - 8 * 1024 * 1024) throw new EvidencePackageError("PACKAGE_LIMIT", "Artifact omitted to preserve package metadata space", 413);
    const target = path.join(this.root, name); await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.link(source, target);
    this.files.set(name, { path: name, sha256, size }); this.totalBytes += size;
  }
  async zip(projectId: string, target: string, timestamp: number): Promise<void> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
    const streams: Readable[] = [];
    await new Promise<void>((resolve, reject) => {
      let failed = false; let bytes = 0;
      const fail = (error: unknown) => {
        if (failed) return; failed = true;
        archive.abort(); for (const stream of streams) stream.destroy(); output.destroy(); reject(error);
      };
      output.on("close", () => { if (!failed) resolve(); }); output.on("error", fail);
      archive.on("warning", fail); archive.on("error", fail);
      archive.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > ZIP_BYTES) fail(new EvidencePackageError("ZIP_LIMIT", "Archive exceeded its byte limit", 413)); });
      archive.pipe(output);
      for (const file of [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        const stream = verifiedEvidenceStream(projectId, path.join(this.root, file.path), file);
        streams.push(stream); stream.on("error", fail);
        archive.append(stream, { name: file.path, mode: 0o644, date: new Date(timestamp) });
      }
      void archive.finalize().catch(fail);
    });
    const handle = await fs.promises.open(target, "r"); try { await handle.sync(); } finally { await handle.close(); }
  }
}
