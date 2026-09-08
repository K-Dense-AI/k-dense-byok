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

/** Streaming SHA-256 of a local file; never blocks the event loop on a large file. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface LocalInputPlan {
  manifest: ModalTransferFile[];
  localByPath: Map<string, string>;
}

/**
 * Enumerate and validate inputs (existence, containment, symlink escapes,
 * limits) without reading their bytes. Runs synchronously inside `submit`, so
 * it must stay cheap; hashes are added by `hashInputPlan` at execute time.
 */
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
    manifest.push({ path: rel, size: stat.size });
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

/** Fill in `sha256` for every planned input by streaming the files. Mutates and returns the plan. */
export async function hashInputPlan(plan: LocalInputPlan): Promise<LocalInputPlan> {
  for (const file of plan.manifest) {
    if (file.sha256) continue;
    const local = plan.localByPath.get(file.path);
    if (!local) throw new ModalTransferError("INPUT_MISSING", `Planned input vanished: ${file.path}`, 404);
    file.sha256 = await sha256File(local);
    const size = fs.statSync(local).size;
    if (size !== file.size) {
      throw new ModalTransferError("INPUT_CHANGED", `Input changed while it was being prepared: ${file.path}`, 409);
    }
  }
  return plan;
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

const REMOTE_CONTROL_DIR = `${REMOTE_WORKDIR}/.kady-job`;
const REMOTE_INPUT_MANIFEST = `${REMOTE_CONTROL_DIR}/inputs.json`;
const REMOTE_OUTPUT_LIST = `${REMOTE_CONTROL_DIR}/outputs.json`;
const REMOTE_OUTPUT_HASHES = `${REMOTE_CONTROL_DIR}/outputs.sha256`;

/** argv[1]: JSON manifest [{path, sha256}] under /workspace. Exit 1 lists mismatches. */
const VERIFY_INPUTS_SCRIPT = [
  "import hashlib,json,sys",
  "files=json.load(open(sys.argv[1]))",
  "bad=[]",
  "for f in files:",
  " h=hashlib.sha256()",
  " with open('/workspace/'+f['path'],'rb') as r:",
  "  for chunk in iter(lambda:r.read(1048576),b''): h.update(chunk)",
  " if h.hexdigest()!=f['sha256']: bad.append(f['path'])",
  "if bad:",
  " sys.stdout.write('\\n'.join(bad)+'\\n'); sys.exit(1)",
  "",
].join("\n");

/** argv[1]: JSON list of paths under /workspace; argv[2]: output file of `<sha256> <path>` lines. */
const HASH_OUTPUTS_SCRIPT = [
  "import hashlib,json,sys",
  "files=json.load(open(sys.argv[1]))",
  "out=[]",
  "for p in files:",
  " h=hashlib.sha256()",
  " with open('/workspace/'+p,'rb') as r:",
  "  for chunk in iter(lambda:r.read(1048576),b''): h.update(chunk)",
  " out.append(h.hexdigest()+' '+p)",
  "open(sys.argv[2],'w').write('\\n'.join(out)+('\\n' if out else ''))",
  "",
].join("\n");

function pythonUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|ENOENT|executable/i.test(message);
}

/**
 * Re-hash the uploaded bytes inside the sandbox and compare them with the
 * manifest, closing the window between hashing locally and the upload. Runs
 * for every job. Returns "skipped" only when the image has no `python3` and
 * the caller did not require verification.
 */
export async function verifyStagedInputs(
  sandbox: ModalRemoteSandbox,
  manifest: ModalTransferFile[],
  checked: <T>(promise: Promise<T>) => Promise<T>,
  options: { required: boolean },
): Promise<"verified" | "skipped" | "empty"> {
  const hashed = manifest.filter((file) => file.sha256);
  if (!hashed.length) return "empty";
  await checked(sandbox.filesystem.makeDirectory(REMOTE_CONTROL_DIR, { createParents: true }));
  await checked(
    sandbox.filesystem.writeText(
      JSON.stringify(hashed.map((file) => ({ path: file.path, sha256: file.sha256 }))),
      REMOTE_INPUT_MANIFEST,
    ),
  );
  let exitCode: number;
  try {
    const process = await checked(
      sandbox.exec(["python3", "-I", "-c", VERIFY_INPUTS_SCRIPT, REMOTE_INPUT_MANIFEST], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    exitCode = await checked(process.wait());
  } catch (error) {
    if (error instanceof ModalJobError && error.code === "CANCELLED") throw error;
    if (!pythonUnavailable(error)) throw error;
    exitCode = 127;
  }
  if (exitCode === 0) return "verified";
  if (exitCode === 1) {
    throw new ModalTransferError("INPUT_CHANGED", "Uploaded inputs do not match the planned checksums", 409);
  }
  if (exitCode === 127) {
    if (options.required) {
      throw new ModalTransferError(
        "REMOTE_VERIFY_UNAVAILABLE",
        "The image has no python3, so uploaded inputs cannot be verified; approved work requires verification",
        422,
      );
    }
    return "skipped";
  }
  throw new ModalJobError("REMOTE_VERIFY_FAILED", `Remote input verification exited with code ${exitCode}`, 502, true);
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

const notFound = (error: unknown): boolean =>
  (error instanceof ModalJobError && error.code === "REMOTE_NOT_FOUND") ||
  /not found|no such file|ENOENT/i.test(error instanceof Error ? error.message : String(error));

/**
 * Walk one directory under /workspace (relative `root`, "" for the root)
 * and return its regular files. Application state (`.kady`, `.pi`, the job
 * control directory) is never collected, whatever the pattern matched.
 */
async function listRemoteFiles(
  sandbox: ModalRemoteSandbox,
  checked: <T>(promise: Promise<T>) => Promise<T>,
  root: string,
  budget: { entries: number },
): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  const walk = async (dir: string, top: boolean): Promise<void> => {
    let children: readonly { path: string; type: string; size: number }[];
    try {
      children = await checked(sandbox.filesystem.listFiles(dir));
    } catch (error) {
      if (top && notFound(error)) return; // the pattern's prefix directory does not exist
      throw error;
    }
    for (const child of children) {
      budget.entries++;
      if (budget.entries > MAX_OUTPUT_DISCOVERY_ENTRIES) {
        throw new ModalTransferError(
          "OUTPUT_DISCOVERY_LIMIT",
          `Remote output discovery exceeded ${MAX_OUTPUT_DISCOVERY_ENTRIES} entries`,
          413,
        );
      }
      const rel = path.posix.relative(REMOTE_WORKDIR, child.path);
      if (!rel || rel.startsWith("../")) continue;
      if (RESERVED_ROOTS.has(rel.split("/")[0])) continue;
      if (child.type === "symlink") {
        throw new ModalTransferError(
          "REMOTE_SYMLINK",
          `Remote outputs may not contain symlinks: ${rel}`,
        );
      }
      if (child.type === "directory") await walk(child.path, false);
      else if (child.type === "file") files.push({ path: rel, size: child.size });
    }
  };
  await walk(root ? path.posix.join(REMOTE_WORKDIR, root) : REMOTE_WORKDIR, true);
  return files;
}

/** Directory segments of a pattern before its first glob segment. */
function literalPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const out: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?]/.test(segment)) break;
    out.push(segment);
  }
  return out.join("/");
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process holds open (EPERM);
      // a preview panel reading the previous version is the usual culprit.
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export async function collectOutputs(args: {
  sandbox: ModalRemoteSandbox;
  sandboxRoot: string;
  stagingDir: string;
  patterns: string[];
  /** Optional stricter server-owned limits for approved structured workflows. */
  maxFiles?: number;
  maxBytes?: number;
  /** Fail instead of degrading when the image cannot hash outputs (approved work). */
  requireHashes?: boolean;
  checked: <T>(promise: Promise<T>) => Promise<T>;
}): Promise<{ files: ModalTransferFile[]; missing: string[]; verified: boolean }> {
  if (args.patterns.length > MAX_OUTPUT_PATTERNS) {
    throw new ModalTransferError(
      "OUTPUT_PATTERN_LIMIT",
      `At most ${MAX_OUTPUT_PATTERNS} output paths/globs are allowed`,
    );
  }
  const patterns = args.patterns.map(normalizeTransferPath);
  if (patterns.length === 0) return { files: [], missing: [], verified: true };
  const { sandbox, checked } = args;

  // Discover only where a pattern can match: a literal path is stat'ed, a
  // glob walks its literal prefix directory. Walking all of /workspace made
  // `files_out: ["results.csv"]` fail on a job that created a venv.
  const budget = { entries: 0 };
  const walked = new Map<string, Promise<RemoteFile[]>>();
  const walkOnce = (root: string) => {
    let pending = walked.get(root);
    if (!pending) {
      pending = listRemoteFiles(sandbox, checked, root, budget);
      walked.set(root, pending);
    }
    return pending;
  };
  const selected = new Map<string, RemoteFile>();
  const missing: string[] = [];
  for (const pattern of patterns) {
    let matches: RemoteFile[] = [];
    if (hasGlob(pattern)) {
      const regex = globRegex(pattern);
      matches = (await walkOnce(literalPrefix(pattern))).filter((file) => regex.test(file.path));
    } else {
      let info: { type: string; size: number } | null = null;
      try {
        info = await checked(sandbox.filesystem.stat(path.posix.join(REMOTE_WORKDIR, pattern)));
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      if (info?.type === "file") matches = [{ path: pattern, size: info.size }];
      else if (info?.type === "directory") matches = await walkOnce(pattern);
      else if (info?.type === "symlink") {
        throw new ModalTransferError("REMOTE_SYMLINK", `Remote outputs may not contain symlinks: ${pattern}`);
      }
    }
    if (matches.length === 0) missing.push(pattern);
    for (const file of matches) selected.set(file.path, file);
  }
  const files = [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    if (RESERVED_ROOTS.has(file.path.split("/")[0])) {
      throw new ModalTransferError("RESERVED_PATH", `Output path is reserved for application state: ${file.path}`, 403);
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const maxFiles = Math.min(args.maxFiles ?? MAX_TRANSFER_FILES, MAX_TRANSFER_FILES);
  const maxBytes = Math.min(args.maxBytes ?? MAX_TRANSFER_BYTES, MAX_TRANSFER_BYTES);
  if (files.length > maxFiles || totalBytes > maxBytes) {
    throw new ModalTransferError(
      "TRANSFER_LIMIT",
      `Output transfer exceeds ${maxFiles} files or ${maxBytes} bytes`,
      413,
    );
  }
  if (files.length === 0) return { files: [], missing, verified: true };

  // Hash the outputs where they are before downloading, so the manifest and
  // the provenance step describe the bytes the command produced, not merely
  // whatever arrived. Without python3 in the image this degrades to the size
  // check (reported to the caller) unless hashes are required.
  let expected: Map<string, string> | null = null;
  await checked(sandbox.filesystem.makeDirectory(REMOTE_CONTROL_DIR, { createParents: true }));
  await checked(sandbox.filesystem.writeText(JSON.stringify(files.map((file) => file.path)), REMOTE_OUTPUT_LIST));
  let hashExit: number;
  try {
    const process = await checked(
      sandbox.exec(["python3", "-I", "-c", HASH_OUTPUTS_SCRIPT, REMOTE_OUTPUT_LIST, REMOTE_OUTPUT_HASHES], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    hashExit = await checked(process.wait());
  } catch (error) {
    if (error instanceof ModalJobError && error.code === "CANCELLED") throw error;
    if (!pythonUnavailable(error)) throw error;
    hashExit = 127;
  }
  if (hashExit === 0) {
    expected = new Map();
    const listing = await checked(sandbox.filesystem.readText(REMOTE_OUTPUT_HASHES));
    for (const line of listing.split("\n")) {
      const space = line.indexOf(" ");
      if (space === 64) expected.set(line.slice(space + 1), line.slice(0, 64));
    }
    for (const file of files) {
      if (!expected.has(file.path)) {
        throw new ModalJobError("REMOTE_HASH_FAILED", `Remote hashing returned no digest for ${file.path}`, 502, true);
      }
    }
  } else if (hashExit === 127) {
    if (args.requireHashes) {
      throw new ModalTransferError(
        "REMOTE_VERIFY_UNAVAILABLE",
        "The image has no python3, so outputs cannot be hashed remotely; approved work requires verification",
        422,
      );
    }
  } else {
    throw new ModalJobError("REMOTE_HASH_FAILED", `Remote output hashing exited with code ${hashExit}`, 502, true);
  }

  fs.rmSync(args.stagingDir, { recursive: true, force: true });
  fs.mkdirSync(args.stagingDir, { recursive: true });
  const manifest: ModalTransferFile[] = [];
  for (const file of files) {
    const staged = path.join(args.stagingDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    await checked(
      sandbox.filesystem.copyToLocal(path.posix.join(REMOTE_WORKDIR, file.path), staged),
    );
    const stat = fs.statSync(staged);
    if (!stat.isFile() || stat.size !== file.size) {
      throw new ModalTransferError(
        "TRANSFER_TRUNCATED",
        `Output changed or was truncated during transfer: ${file.path}`,
      );
    }
    const sha256 = await sha256File(staged);
    const remote = expected?.get(file.path);
    if (remote && remote !== sha256) {
      throw new ModalTransferError(
        "CHECKSUM_MISMATCH",
        `Downloaded bytes do not match the sandbox's checksum: ${file.path}`,
      );
    }
    manifest.push({ path: file.path, size: stat.size, sha256 });
  }

  // Install only after every requested output has staged and verified. Every
  // file is first copied next to its final path, then all are renamed, so a
  // failure while copying installs nothing and the sandbox keeps its previous
  // versions. Renames after successful copies are the residual window.
  const finals = manifest.map((file) => {
    const final = safeLocal(args.sandboxRoot, file.path);
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(final);
    } catch {
      /* new file */
    }
    if (existing?.isDirectory()) {
      throw new ModalTransferError("OUTPUT_TARGET_IS_DIRECTORY", `Output path is an existing directory: ${file.path}`);
    }
    return { file, final, incoming: `${final}.modal-${crypto.randomBytes(6).toString("hex")}.tmp` };
  });
  const pendingTmp = new Set<string>();
  try {
    for (const { file, final, incoming } of finals) {
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.copyFileSync(path.join(args.stagingDir, ...file.path.split("/")), incoming);
      pendingTmp.add(incoming);
    }
    for (const { final, incoming } of finals) {
      await renameWithRetry(incoming, final);
      pendingTmp.delete(incoming);
    }
  } finally {
    for (const tmp of pendingTmp) fs.rmSync(tmp, { force: true });
  }
  return { files: manifest, missing, verified: expected !== null };
}
