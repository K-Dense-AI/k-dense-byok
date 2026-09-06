/**
 * Environment snapshots: *in what* a step ran, not just what ran.
 *
 * A provenance step binds `python de_analysis.py` to the files it read and
 * wrote. That is enough to know where a figure came from, but not enough to get
 * it again — the same script under pandas 1.5 and 2.2 can disagree. This module
 * captures the sandbox's execution environment once per run (and again after a
 * command that changes it) so steps can point at it.
 *
 * What is captured, and how cheaply:
 *   - Python: the uv-managed sandbox venv. Version from `.venv/pyvenv.cfg`,
 *     packages from the `*.dist-info` directory names in site-packages. No
 *     subprocess at all, which matters because this runs on every run start.
 *   - R: version + installed packages via one `Rscript` call, only when Rscript
 *     is on PATH, bounded by a timeout.
 *   - Lockfiles: sha256 of uv.lock / pyproject.toml / requirements*.txt /
 *     environment.yml / renv.lock — the declarative environment, which is what
 *     a reader actually reproduces from.
 *   - Git HEAD of the sandbox, if it is a repository. Read from `.git`, no
 *     subprocess.
 *   - OS platform/release/arch and the uv version.
 *
 * Snapshots are content-addressed (id = sha256 of everything except
 * `capturedAt`) and stored once under `.kady/environments/<id>.json`, so a
 * hundred runs against an unchanged venv share one record. Like every other
 * provenance row, nothing here comes from the model's account of itself.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { findUv, lookPath } from "../binaries.ts";
import { resolvePaths } from "../projects.ts";
import { apiRelative } from "../sandbox-fs.ts";
import { sha256File } from "./store.ts";

export const ENVIRONMENT_SCHEMA_VERSION = 1 as const;

/** Package lists are bounded so one snapshot never balloons a response. */
export const MAX_PACKAGES = 2_000;

/** R and version probes are best-effort; a hung interpreter must not stall
 *  provenance for the whole run. */
const PROBE_TIMEOUT_MS = 15_000;

/** Files whose presence and hash define the declared environment. Root of the
 *  sandbox only — a lockfile inside a vendored dependency is not ours. */
export const LOCKFILE_NAMES = [
  "uv.lock",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "environment.yml",
  "environment.yaml",
  "renv.lock",
  "DESCRIPTION",
  "Project.toml",
  "Manifest.toml",
] as const;

export interface PackageVersion {
  name: string;
  version: string;
}

export interface EnvironmentSnapshot {
  schemaVersion: typeof ENVIRONMENT_SCHEMA_VERSION;
  /** sha256 over the canonical content (everything but `capturedAt`). */
  id: string;
  capturedAt: number;
  os: { platform: string; release: string; arch: string };
  python?: {
    version?: string;
    /** `venv` = the sandbox's uv-managed .venv; `system` = whatever `python3`
     *  resolves to on PATH, in which case no package list is available. */
    source: "venv" | "system";
    packages: PackageVersion[];
    packagesTruncated?: number;
  };
  r?: {
    version: string;
    packages: PackageVersion[];
    packagesTruncated?: number;
  };
  lockfiles: Array<{ path: string; sha256: string }>;
  git?: { head: string };
  tools?: { uv?: string };
}

// ---------------------------------------------------------------------------
// Capture

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Python version from a venv's pyvenv.cfg. uv writes `version_info`, the
 *  stdlib `venv` writes `version`; both are `X.Y.Z`. */
export function pythonVersionFromPyvenvCfg(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(version_info|version)\s*=\s*(\S+)/.exec(line);
    if (match) return match[2];
  }
  return undefined;
}

/**
 * `Name-Version.dist-info` -> {name, version}. PEP 427 normalizes the name so it
 * carries no `-`, and a PEP 440 version has none either, so the single dash is
 * the split. Anything else falls back to the METADATA file.
 */
export function parseDistInfoName(dirName: string): PackageVersion | null {
  if (!dirName.endsWith(".dist-info")) return null;
  const stem = dirName.slice(0, -".dist-info".length);
  const dash = stem.indexOf("-");
  if (dash <= 0 || dash === stem.length - 1) return null;
  return { name: stem.slice(0, dash), version: stem.slice(dash + 1) };
}

function parseMetadata(content: string): PackageVersion | null {
  let name: string | undefined;
  let version: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line === "") break; // end of headers
    if (!name && line.startsWith("Name:")) name = line.slice(5).trim();
    else if (!version && line.startsWith("Version:")) version = line.slice(8).trim();
    if (name && version) break;
  }
  return name && version ? { name, version } : null;
}

/** Every site-packages directory a venv can hold, across platforms. */
function sitePackagesDirs(venv: string): string[] {
  const out: string[] = [];
  const win = path.join(venv, "Lib", "site-packages");
  if (fs.existsSync(win)) out.push(win);
  const lib = path.join(venv, "lib");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(lib);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^python\d/.test(entry)) continue;
    const dir = path.join(lib, entry, "site-packages");
    if (fs.existsSync(dir)) out.push(dir);
  }
  return out;
}

export function listVenvPackages(venv: string): { packages: PackageVersion[]; truncated: number } {
  const found = new Map<string, string>();
  let total = 0;
  for (const site of sitePackagesDirs(venv)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(site, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      total++;
      let parsed = parseDistInfoName(entry.name);
      if (!parsed) {
        const meta = readText(path.join(site, entry.name, "METADATA"));
        parsed = meta ? parseMetadata(meta) : null;
      }
      if (!parsed) continue;
      if (found.size < MAX_PACKAGES) found.set(parsed.name.toLowerCase(), parsed.version);
    }
  }
  const packages = [...found]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { packages, truncated: Math.max(0, total - packages.length) };
}

function exec(
  file: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) return resolve(null);
          resolve(`${stdout ?? ""}${stderr ?? ""}`);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function capturePython(
  sandboxRoot: string,
): Promise<EnvironmentSnapshot["python"] | undefined> {
  const venv = path.join(sandboxRoot, ".venv");
  const cfg = readText(path.join(venv, "pyvenv.cfg"));
  if (cfg !== null) {
    const { packages, truncated } = listVenvPackages(venv);
    const version = pythonVersionFromPyvenvCfg(cfg);
    return {
      ...(version ? { version } : {}),
      source: "venv",
      packages,
      ...(truncated > 0 ? { packagesTruncated: truncated } : {}),
    };
  }
  // No sandbox venv: the agent was told to use uv, but a bare `python3` call
  // still runs against whatever is on PATH. Record its version so the gap is at
  // least visible; a package list would mean a pip subprocess per run.
  const python =
    process.platform === "win32" ? lookPath("python") ?? lookPath("py") : lookPath("python3");
  if (!python) return undefined;
  const out = await exec(python, ["--version"], sandboxRoot);
  const version = out ? /Python\s+(\S+)/.exec(out)?.[1] : undefined;
  return { ...(version ? { version } : {}), source: "system", packages: [] };
}

/** One Rscript call: first line the version string, then `name==version` rows. */
const R_PROBE =
  'cat(R.version.string, "\\n", sep=""); ip <- installed.packages()[, c("Package", "Version"), drop = FALSE]; cat(paste(ip[, 1], ip[, 2], sep = "=="), sep = "\\n")';

export function parseRProbe(output: string): EnvironmentSnapshot["r"] | undefined {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  const versionLine = lines.find((line) => /^R version/.test(line));
  if (!versionLine) return undefined;
  const packages: PackageVersion[] = [];
  let total = 0;
  for (const line of lines) {
    const eq = line.indexOf("==");
    if (eq <= 0) continue;
    total++;
    if (packages.length < MAX_PACKAGES) {
      packages.push({ name: line.slice(0, eq).trim(), version: line.slice(eq + 2).trim() });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = total - packages.length;
  return {
    version: versionLine.trim(),
    packages,
    ...(truncated > 0 ? { packagesTruncated: truncated } : {}),
  };
}

async function captureR(sandboxRoot: string): Promise<EnvironmentSnapshot["r"] | undefined> {
  const rscript = lookPath("Rscript");
  if (!rscript) return undefined;
  // Not --vanilla: an renv project activates through .Rprofile, and the
  // activated library is the one the agent's scripts actually ran against.
  const out = await exec(rscript, ["-e", R_PROBE], sandboxRoot);
  return out ? parseRProbe(out) : undefined;
}

function captureLockfiles(sandboxRoot: string): EnvironmentSnapshot["lockfiles"] {
  const out: EnvironmentSnapshot["lockfiles"] = [];
  for (const name of LOCKFILE_NAMES) {
    const abs = path.join(sandboxRoot, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const digest = sha256File(abs);
    if (digest) out.push({ path: name, sha256: digest });
  }
  return out;
}

/** Resolve HEAD to a commit without spawning git. Handles a detached HEAD, a
 *  loose ref, and a packed ref; gives up (undefined) on anything else. */
export function readGitHead(sandboxRoot: string): string | undefined {
  const gitDir = path.join(sandboxRoot, ".git");
  const head = readText(path.join(gitDir, "HEAD"))?.trim();
  if (!head) return undefined;
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  const ref = /^ref:\s*(\S+)/.exec(head)?.[1];
  if (!ref) return undefined;
  const loose = readText(path.join(gitDir, ...ref.split("/")))?.trim();
  if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  const packed = readText(path.join(gitDir, "packed-refs"));
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40,64})\s+(\S+)/.exec(line);
      if (match && match[2] === ref) return match[1];
    }
  }
  return undefined;
}

async function captureUvVersion(sandboxRoot: string): Promise<string | undefined> {
  const uv = findUv();
  if (!uv) return undefined;
  const out = await exec(uv, ["--version"], sandboxRoot);
  return out ? /uv\s+(\S+)/.exec(out)?.[1] : undefined;
}

/** Stable id: hash of the snapshot minus the fields that vary per capture. */
export function environmentId(snapshot: Omit<EnvironmentSnapshot, "id" | "capturedAt">): string {
  const canonical = JSON.stringify(snapshot, Object.keys(flatten(snapshot)).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Collect every key name in a nested object so JSON.stringify's replacer array
 *  can sort them — key order must not change the id. */
function flatten(value: unknown, into: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      into[key] = true;
      flatten(item, into);
    }
  }
  return into;
}

export type EnvironmentCapture = (sandboxRoot: string) => Promise<EnvironmentSnapshot | null>;

/**
 * Capture the sandbox environment. Never throws; a probe that fails simply
 * leaves its section out, and a wholesale failure yields null so the recorder
 * can carry on without an environment id rather than without a step.
 */
export const captureEnvironment: EnvironmentCapture = async (sandboxRoot) => {
  try {
    const [python, r, uv] = await Promise.all([
      capturePython(sandboxRoot),
      captureR(sandboxRoot),
      captureUvVersion(sandboxRoot),
    ]);
    const body: Omit<EnvironmentSnapshot, "id" | "capturedAt"> = {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      ...(python ? { python } : {}),
      ...(r ? { r } : {}),
      lockfiles: captureLockfiles(sandboxRoot),
    };
    const head = readGitHead(sandboxRoot);
    if (head) body.git = { head };
    if (uv) body.tools = { uv };
    return { ...body, id: environmentId(body), capturedAt: Date.now() };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Store

function environmentPath(id: string, projectId: string): string {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid environment id: ${id}`);
  return path.join(resolvePaths(projectId).environmentsDir, `${id}.json`);
}

/** Write-if-missing: content-addressed, so an existing file is already right. */
export function storeEnvironment(snapshot: EnvironmentSnapshot, projectId: string): void {
  const file = environmentPath(snapshot.id, projectId);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // A concurrent writer won the race; same content by construction.
    fs.rmSync(tmp, { force: true });
  }
}

export function readEnvironment(id: string, projectId: string): EnvironmentSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(environmentPath(id, projectId), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as EnvironmentSnapshot;
    return parsed.schemaVersion === ENVIRONMENT_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** Capture + persist, returning the id (or undefined on failure). */
export async function captureAndStoreEnvironment(
  sandboxRoot: string,
  projectId: string,
  capture: EnvironmentCapture = captureEnvironment,
): Promise<string | undefined> {
  const snapshot = await capture(sandboxRoot);
  if (!snapshot) return undefined;
  storeEnvironment(snapshot, projectId);
  return snapshot.id;
}

// ---------------------------------------------------------------------------
// Change detection

/** Sandbox-relative paths whose change means the environment moved. */
const LOCKFILE_SET = new Set<string>(LOCKFILE_NAMES);

/** Shell fragments that install or remove packages. Deliberately broad — a
 *  spurious re-capture costs a directory listing, a missed one costs the
 *  record's accuracy. */
const ENV_CHANGING_COMMAND =
  /\b(uv\s+(add|remove|sync|pip\s+(install|uninstall))|pip3?\s+(install|uninstall)|conda\s+(install|remove|update|env)|mamba\s+(install|remove|update)|install\.packages|remove\.packages|renv::(install|restore|remove)|BiocManager::install|apt(-get)?\s+install|brew\s+install|npm\s+(install|i|add)|R\s+CMD\s+INSTALL)\b/;

/**
 * Did this step plausibly change the environment? True when its command
 * matches an install/remove pattern, or when the scan-diff shows a lockfile at
 * the sandbox root changed.
 *
 * The scan-diff alone is not enough: `uv.lock` is hidden from users, so the
 * sandbox scan never sees it, and `uv run` syncs the venv without saying so.
 * Callers pair this with `environmentFingerprint`, which stats the venv and
 * lockfiles directly.
 */
export function environmentMayHaveChanged(args: unknown, changedPaths: Iterable<string>): boolean {
  for (const rel of changedPaths) {
    if (LOCKFILE_SET.has(rel)) return true;
  }
  const command = commandFromArgs(args);
  return command !== null && ENV_CHANGING_COMMAND.test(command);
}

/**
 * Cheap identity of the on-disk environment: size+mtime of every lockfile at
 * the sandbox root, the venv's pyvenv.cfg, and each site-packages directory
 * (a directory's mtime moves when a package is added or removed). A handful of
 * stats, no hashing — cheap enough to run after every opaque tool call. Two
 * equal fingerprints mean no re-capture is needed; anything else means the
 * full snapshot should be taken again.
 */
export function environmentFingerprint(sandboxRoot: string): string {
  const parts: string[] = [];
  const stat = (abs: string): void => {
    try {
      const st = fs.statSync(abs);
      parts.push(`${apiRelative(sandboxRoot, abs)}:${st.size}:${st.mtimeMs}`);
    } catch {
      // absent: contributes nothing, so appearing later changes the fingerprint
    }
  };
  for (const name of LOCKFILE_NAMES) stat(path.join(sandboxRoot, name));
  const venv = path.join(sandboxRoot, ".venv");
  stat(path.join(venv, "pyvenv.cfg"));
  for (const site of sitePackagesDirs(venv)) stat(site);
  return parts.join("|");
}

/** The shell string of an opaque tool call, across Pi's bash tool and the
 *  common MCP shapes. */
export function commandFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
