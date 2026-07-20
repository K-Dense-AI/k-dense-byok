import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../sandbox-fs.ts";
import type { ModalRemoteSandbox } from "./adapter.ts";
import { ModalJobError, type ModalTransferFile } from "./types.ts";

export const MAX_TRANSFER_FILES = 10_000;
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_OUTPUT_PATTERNS = 128;
export const MAX_OUTPUT_DISCOVERY_ENTRIES = 20_000;
const REMOTE_WORKDIR = "/workspace";
const RESERVED_ROOTS = new Set([".kady", ".pi", ".kady-job"]);
const REMOTE_INPUT_STAGING = "/tmp/kady-inputs";

export class ModalTransferError extends ModalJobError {
  constructor(code: string, message: string, statusCode = 400) {
    super(code, message, statusCode, false);
    this.name = "ModalTransferError";
  }
}

export function normalizeTransferPath(raw: string): string {
  if (typeof raw !== "string" || raw.includes("\0")) {
    throw new ModalTransferError("INVALID_PATH", "Transfer paths must be strings without NUL bytes");
  }
  const slash = raw.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const normalized = path.posix.normalize(slash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new ModalTransferError("PATH_ESCAPE", `Path escapes the project sandbox: ${raw}`, 403);
  }
  if (RESERVED_ROOTS.has(normalized.split("/")[0])) {
    throw new ModalTransferError(
      "RESERVED_PATH",
      `Transfer path is reserved for application state: ${raw}`,
      403,
    );
  }
  return normalized;
}

function safeLocal(sandboxRoot: string, rel: string): string {
  const target = path.resolve(sandboxRoot, ...rel.split("/"));
  if (!isWithin(sandboxRoot, target)) {
    throw new ModalTransferError("PATH_ESCAPE", `Path escapes the project sandbox: ${rel}`, 403);
  }
  const realRoot = fs.realpathSync(sandboxRoot);
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  if (!isWithin(realRoot, realExisting)) {
    throw new ModalTransferError(
      "SYMLINK_ESCAPE",
      `Path resolves through a symlink outside the project sandbox: ${rel}`,
      403,
    );
  }
  return target;
}

function sha256(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export interface LocalInputPlan {
  manifest: ModalTransferFile[];
  localByPath: Map<string, string>;
}

export function planInputs(sandboxRoot: string, requested: string[]): LocalInputPlan {
  const manifest: ModalTransferFile[] = [];
  const localByPath = new Map<string, string>();
  const seenFiles = new Set<string>();
  const activeDirectories = new Set<string>();
  const realRoot = fs.realpathSync(sandboxRoot);
  let totalBytes = 0;

  const addFile = (local: string, rel: string) => {
    const real = fs.realpathSync(local);
    if (!isWithin(realRoot, real)) {
      throw new ModalTransferError("SYMLINK_ESCAPE", `Symlink escapes the project sandbox: ${rel}`, 403);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      throw new ModalTransferError("UNSUPPORTED_INPUT", `Input is not a regular file: ${rel}`);
    }
    const key = `${real}:${rel}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    totalBytes += stat.size;
    if (manifest.length + 1 > MAX_TRANSFER_FILES || totalBytes > MAX_TRANSFER_BYTES) {
      throw new ModalTransferError(
        "TRANSFER_LIMIT",
        `Input transfer exceeds ${MAX_TRANSFER_FILES} files or ${MAX_TRANSFER_BYTES} bytes`,
        413,
      );
    }
    manifest.push({ path: rel, size: stat.size, sha256: sha256(real) });
    localByPath.set(rel, real);
  };

  const walk = (local: string, rel: string) => {
    const lst = fs.lstatSync(local);
    const real = fs.realpathSync(local);
    if (!isWithin(realRoot, real)) {
      throw new ModalTransferError("SYMLINK_ESCAPE", `Symlink escapes the project sandbox: ${rel}`, 403);
    }
    const stat = lst.isSymbolicLink() ? fs.statSync(real) : lst;
    if (stat.isFile()) {
      addFile(local, rel);
      return;
    }
    if (!stat.isDirectory()) {
      throw new ModalTransferError("UNSUPPORTED_INPUT", `Input is not a file or directory: ${rel}`);
    }
    if (activeDirectories.has(real)) {
      throw new ModalTransferError("SYMLINK_LOOP", `Directory symlink loop at: ${rel}`);
    }
    activeDirectories.add(real);
    try {
      const names = fs.readdirSync(real).sort();
      for (const name of names) {
        walk(path.join(real, name), path.posix.join(rel, name));
      }
    } finally {
      activeDirectories.delete(real);
    }
  };

  for (const raw of requested) {
    const rel = normalizeTransferPath(raw);
    const local = safeLocal(sandboxRoot, rel);
    if (!fs.existsSync(local)) {
      throw new ModalTransferError("INPUT_MISSING", `Required input does not exist: ${rel}`, 404);
    }
    walk(local, rel);
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  return { manifest, localByPath };
}

export async function stageInputs(
  sandbox: ModalRemoteSandbox,
  plan: LocalInputPlan,
  checked: <T>(promise: Promise<T>) => Promise<T>,
): Promise<void> {
  const made = new Set<string>();
  await checked(
    sandbox.filesystem.makeDirectory(REMOTE_INPUT_STAGING, { createParents: true }),
  );
  for (const file of plan.manifest) {
    const remote = path.posix.join(REMOTE_WORKDIR, file.path);
    const dir = path.posix.dirname(remote);
    if (!made.has(dir)) {
      await checked(sandbox.filesystem.makeDirectory(dir, { createParents: true }));
      made.add(dir);
    }
    const staged = path.posix.join(
      REMOTE_INPUT_STAGING,
      crypto.createHash("sha256").update(file.path).digest("hex"),
    );
    await checked(
      sandbox.filesystem.copyFromLocal(plan.localByPath.get(file.path)!, staged),
    );
    const install = await checked(
      sandbox.exec(["mv", "--", staged, remote], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = await checked(install.wait());
    if (exitCode !== 0) {
      throw new ModalTransferError(
        "REMOTE_INSTALL_FAILED",
        `Could not atomically install remote input: ${file.path}`,
        502,
      );
    }
  }
}

function globRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

interface RemoteFile {
  path: string;
  size: number;
}

async function listRemoteFiles(
  sandbox: ModalRemoteSandbox,
  checked: <T>(promise: Promise<T>) => Promise<T>,
): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  let entries = 0;
  const walk = async (dir: string): Promise<void> => {
    const children = await checked(sandbox.filesystem.listFiles(dir));
    for (const child of children) {
      entries++;
      if (entries > MAX_OUTPUT_DISCOVERY_ENTRIES) {
        throw new ModalTransferError(
          "OUTPUT_DISCOVERY_LIMIT",
          `Remote output discovery exceeded ${MAX_OUTPUT_DISCOVERY_ENTRIES} entries`,
          413,
        );
      }
      const rel = path.posix.relative(REMOTE_WORKDIR, child.path);
      if (!rel || rel.startsWith("../")) continue;
      if (rel === ".kady-job" || rel.startsWith(".kady-job/")) continue;
      if (child.type === "symlink") {
        throw new ModalTransferError(
          "REMOTE_SYMLINK",
          `Remote outputs may not contain symlinks: ${rel}`,
        );
      }
      if (child.type === "directory") await walk(child.path);
      else if (child.type === "file") files.push({ path: rel, size: child.size });
    }
  };
  await walk(REMOTE_WORKDIR);
  return files;
}

export async function collectOutputs(args: {
  sandbox: ModalRemoteSandbox;
  sandboxRoot: string;
  stagingDir: string;
  patterns: string[];
  checked: <T>(promise: Promise<T>) => Promise<T>;
}): Promise<{ files: ModalTransferFile[]; missing: string[] }> {
  if (args.patterns.length > MAX_OUTPUT_PATTERNS) {
    throw new ModalTransferError(
      "OUTPUT_PATTERN_LIMIT",
      `At most ${MAX_OUTPUT_PATTERNS} output paths/globs are allowed`,
    );
  }
  const patterns = args.patterns.map(normalizeTransferPath);
  if (patterns.length === 0) return { files: [], missing: [] };
  const all = await listRemoteFiles(args.sandbox, args.checked);
  const selected = new Map<string, RemoteFile>();
  const missing: string[] = [];
  for (const pattern of patterns) {
    const regex = globRegex(pattern);
    const matches = all.filter((file) =>
      hasGlob(pattern) ? regex.test(file.path) : file.path === pattern || file.path.startsWith(`${pattern}/`),
    );
    if (matches.length === 0) missing.push(pattern);
    for (const file of matches) selected.set(file.path, file);
  }
  const files = [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_TRANSFER_FILES || totalBytes > MAX_TRANSFER_BYTES) {
    throw new ModalTransferError(
      "TRANSFER_LIMIT",
      `Output transfer exceeds ${MAX_TRANSFER_FILES} files or ${MAX_TRANSFER_BYTES} bytes`,
      413,
    );
  }

  fs.rmSync(args.stagingDir, { recursive: true, force: true });
  fs.mkdirSync(args.stagingDir, { recursive: true });
  const manifest: ModalTransferFile[] = [];
  for (const file of files) {
    const staged = path.join(args.stagingDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    await args.checked(
      args.sandbox.filesystem.copyToLocal(path.posix.join(REMOTE_WORKDIR, file.path), staged),
    );
    const stat = fs.statSync(staged);
    if (!stat.isFile() || stat.size !== file.size) {
      throw new ModalTransferError(
        "CHECKSUM_MISMATCH",
        `Output changed or was truncated during transfer: ${file.path}`,
      );
    }
    manifest.push({ path: file.path, size: stat.size, sha256: sha256(staged) });
  }

  // Install only after every requested output has staged successfully. Each
  // final file uses a same-directory rename, so readers never observe a
  // partially-written file and failed downloads leave canonical files intact.
  for (const file of manifest) {
    const staged = path.join(args.stagingDir, ...file.path.split("/"));
    const final = safeLocal(args.sandboxRoot, file.path);
    fs.mkdirSync(path.dirname(final), { recursive: true });
    const incoming = `${final}.modal-${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.copyFileSync(staged, incoming);
    fs.renameSync(incoming, final);
  }
  return { files: manifest, missing };
}
