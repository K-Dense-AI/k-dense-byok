/**
 * Fetching skills from any source, via the `skills` CLI (vercel-labs/skills).
 *
 * The CLI is the *fetcher* only. It downloads into a disposable staging dir
 * under `KADY_SKILLS_CACHE_DIR`, laid out as `<staging>/.pi/skills/<name>/`
 * because `-a pi` targets exactly the directory shape Pi discovers. Installing
 * from there into a project's (or the user's) live skill dirs stays with
 * `skills-sync.ts`, which remains their only writer — that split is what lets
 * us take the CLI's source resolution (GitHub/GitLab/git/archive/local paths,
 * refs, per-skill subpaths) and its lock-file provenance while keeping our own
 * enable/disable placement, tree hashing, atomic replacement, local-edit
 * preservation and archive-on-removal semantics. The CLI only ever writes to
 * staging, where nothing is user-edited, so its update rules cannot collide
 * with ours.
 *
 * The CLI's human-readable stdout is never parsed: truth is the staged
 * directory plus `skills-lock.json`. Output is captured only for error text.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { KADY_SKILLS_CACHE_DIR, SKILLS_BRANCH, SKILLS_REPO } from "../config.ts";

const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
/** Trailing CLI output kept for error messages. */
const OUTPUT_TAIL_LIMIT = 4096;

/** One `skills-lock.json` entry: where a staged skill came from. */
export interface SkillLockEntry {
  source?: string;
  sourceType?: string;
  skillPath?: string;
  ref?: string;
  computedHash?: string;
}

export interface FetchedSkills {
  /** Directory holding `<name>/SKILL.md` trees, ready to install from. */
  skillsDir: string;
  /** Staging root (parent of `.pi/`), where the lock file lives. */
  stagingDir: string;
  lock: Record<string, SkillLockEntry>;
}

export interface FetchSkillsOptions {
  /** `owner/repo`, a git/https URL, or a local path. */
  source: string;
  /** Skill names to fetch; omit or `["*"]` for every skill in the source. */
  names?: string[];
  /** Branch/tag/commit, appended as `#ref` when the source supports it. */
  ref?: string;
  /** Staging subdirectory; same key reuses (and overwrites) the same dir. */
  cacheKey: string;
}

/**
 * Path to the CLI's JS entry point, invoked with our own `node`.
 *
 * Deliberately not `node_modules/.bin/skills`: on Windows that is a `.cmd`
 * shim, and Node refuses to spawn `.cmd` without a shell. Resolving the module
 * entry keeps one spawn shape on every platform and needs no PATH mutation.
 */
export function resolveSkillsCli(): string | null {
  try {
    return createRequire(import.meta.url).resolve("skills/bin/cli.mjs");
  } catch {
    return null;
  }
}

/** Stable staging directory name for an arbitrary source string. */
export function cacheKeyForSource(source: string, ref?: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${source}\0${ref ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  // A readable prefix makes the cache dir diagnosable by eye.
  const slug =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "source";
  return `${slug}-${digest}`;
}

export function stagingDirFor(cacheKey: string): string {
  return path.join(KADY_SKILLS_CACHE_DIR, cacheKey);
}

/** `<staging>/.pi/skills` — where `-a pi` installs. */
export function stagedSkillsDir(stagingDir: string): string {
  return path.join(stagingDir, ".pi", "skills");
}

/** Built from a string so no raw ESC byte has to live in this source file. */
const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]|\\u001b[()][AB0]", "g");

/** Drop the CLI's cursor/colour control sequences so errors read as plain text. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * The CLI is built for a terminal: it draws box art, redraws a spinner line per
 * frame, and opens with a banner about which agent it detected. Once the cursor
 * codes are stripped, all of that survives as fragments that bury the one
 * sentence saying what actually went wrong.
 *
 * Box drawing, block elements, geometric shapes and dingbats (U+2500–U+27BF)
 * plus the `|` column separator are decoration, never content.
 */
const NOISE_GLYPHS = new RegExp("[\\u2500-\\u27bf|]", "g");
/**
 * Progress and banner lines, as opposed to the diagnosis. Note the `\b` only
 * guards the word-shaped prefixes: after a colon it would never match, so
 * `source:` is anchored on its own.
 */
const NOISE_LINES =
  /^(?:fetching|cloning|falling back|downloading|extracting|resolving|installing|reading)\b|^source:|^local path validated|agent detected|non-interactively/i;
const KEPT_ERROR_LINES = 6;

function tail(text: string): string {
  const lines: string[] = [];
  for (const raw of stripAnsi(text).split(/[\r\n]+/)) {
    const line = raw.replace(NOISE_GLYPHS, " ").replace(/\s+/g, " ").trim();
    if (!line || NOISE_LINES.test(line)) continue;
    // A rewritten progress line reappears verbatim on every frame.
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  const clean = lines.slice(-KEPT_ERROR_LINES).join("\n").trim();
  return clean.length > OUTPUT_TAIL_LIMIT ? clean.slice(-OUTPUT_TAIL_LIMIT) : clean;
}

function buildAddArgs(options: FetchSkillsOptions): string[] {
  const source = options.ref ? `${options.source}#${options.ref}` : options.source;
  const names = options.names?.length ? options.names : ["*"];
  const args = ["add", source];
  for (const name of names) args.push("--skill", name);
  // `-a pi` writes `.pi/skills/<name>`; `--copy` keeps real trees rather than
  // symlinks so our directory hashes describe actual content; `-y` suppresses
  // every prompt (the CLI is otherwise interactive).
  args.push("--agent", "pi", "--copy", "--yes");
  return args;
}

/**
 * Recover the absolute path of a local source. Since `skills` 1.5.22 the CLI
 * records local sources relative to the staging dir rather than absolutely, and
 * staging dirs are disposable — a path relative to one is meaningless once the
 * cache is cleared, and it is what we persist as user-visible provenance.
 * Remote sources (`owner/repo`, URLs) are never paths and are left verbatim.
 */
function absoluteLockSource(stagingDir: string, entry: SkillLockEntry): string | undefined {
  const { source, sourceType } = entry;
  if (typeof source !== "string" || !source) return source;
  if (sourceType !== "local" || path.isAbsolute(source)) return source;
  return path.resolve(stagingDir, source);
}

export function readStagedLock(stagingDir: string): Record<string, SkillLockEntry> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stagingDir, "skills-lock.json"), "utf-8"),
    ) as { skills?: unknown };
    if (!raw.skills || typeof raw.skills !== "object") return {};
    const out: Record<string, SkillLockEntry> = {};
    for (const [name, value] of Object.entries(raw.skills as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as SkillLockEntry;
      const source = absoluteLockSource(stagingDir, entry);
      out[name] = {
        ...(typeof source === "string" ? { source } : {}),
        ...(typeof entry.sourceType === "string" ? { sourceType: entry.sourceType } : {}),
        ...(typeof entry.skillPath === "string" ? { skillPath: entry.skillPath } : {}),
        ...(typeof entry.ref === "string" ? { ref: entry.ref } : {}),
        ...(typeof entry.computedHash === "string"
          ? { computedHash: entry.computedHash }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function countStagedSkills(skillsDir: string): number {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")),
      ).length;
  } catch {
    return 0;
  }
}

/**
 * Download `source` into its staging dir and return the staged trees.
 *
 * Throws with the CLI's own message on failure — its errors are already
 * user-facing (e.g. "No matching skills found for: x", listing what exists).
 */
export async function fetchSkills(options: FetchSkillsOptions): Promise<FetchedSkills> {
  const cli = resolveSkillsCli();
  if (!cli) {
    throw new Error(
      "The `skills` CLI is not installed. Run `npm install` in server/ and retry.",
    );
  }

  const stagingDir = stagingDirFor(options.cacheKey);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const args = buildAddArgs(options);
  const { code, output } = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: stagingDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: FETCH_TIMEOUT_MS,
        killSignal: "SIGTERM",
        env: { ...process.env, NO_COLOR: "1" },
      });
      let combined = "";
      const collect = (chunk: string): void => {
        combined += chunk;
        // Keep memory bounded on a chatty run; only the tail is ever used.
        if (combined.length > OUTPUT_TAIL_LIMIT * 4) {
          combined = combined.slice(-OUTPUT_TAIL_LIMIT * 2);
        }
      };
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", reject);
      child.once("close", (exit) => resolve({ code: exit, output: combined }));
    },
  );

  const skillsDir = stagedSkillsDir(stagingDir);
  if (code !== 0) {
    throw new Error(tail(output) || `\`skills add\` exited with status ${code}`);
  }
  if (countStagedSkills(skillsDir) === 0) {
    throw new Error(tail(output) || `No skills found at ${options.source}`);
  }

  return { skillsDir, stagingDir, lock: readStagedLock(stagingDir) };
}

/** Remove a staging directory (best-effort). */
export function clearStaging(cacheKey: string): void {
  fs.rmSync(stagingDirFor(cacheKey), { recursive: true, force: true });
}

// --- the default catalogue ------------------------------------------------

/** Staging key for the K-Dense catalogue: one download serves every project. */
export const CATALOGUE_CACHE_KEY = "catalogue";

export interface FetchedCatalogue {
  skillsDir: string;
  /**
   * Upstream commit, when the fallback clone produced one. The CLI stages
   * copies rather than a checkout, so this is normally null and callers
   * identify a catalogue by the digest of its skill hashes instead.
   */
  commit: string | null;
  /** Release the fetch's temporary storage (no-op for the staging cache). */
  cleanup: () => void;
}

function runGitClone(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        SKILLS_BRANCH,
        `https://github.com/${SKILLS_REPO}.git`,
        target,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: FETCH_TIMEOUT_MS },
    );
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git clone exited with status ${code}`));
    });
  });
}

function runGitRevParse(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? stdout.trim() || null : null));
  });
}

/**
 * Shallow-clone the catalogue. Retained as a fallback for the CLI path: the
 * catalogue is on the first-run seeding path, so a CLI that is missing,
 * broken, or incompatible must not be able to leave a new project with no
 * skills at all.
 */
async function cloneCatalogue(): Promise<FetchedCatalogue> {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kady-skills-clone-"));
  try {
    await runGitClone(tmpRoot);
    const skillsDir = path.join(tmpRoot, "skills");
    if (!fs.existsSync(skillsDir)) {
      throw new Error("Cloned catalogue has no skills directory");
    }
    return {
      skillsDir,
      commit: await runGitRevParse(tmpRoot),
      cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Fetch the default catalogue, preferring the CLI and falling back to a git
 * clone. `onFallback` reports the CLI failure that triggered the fallback —
 * silently degrading would hide a permanently broken CLI behind a slower path
 * that happens to work.
 */
export async function fetchCatalogue(
  onFallback?: (reason: string) => void,
): Promise<FetchedCatalogue> {
  try {
    const staged = await fetchSkills({
      source: SKILLS_REPO,
      ref: SKILLS_BRANCH,
      cacheKey: CATALOGUE_CACHE_KEY,
    });
    return { skillsDir: staged.skillsDir, commit: null, cleanup: () => {} };
  } catch (err) {
    onFallback?.(err instanceof Error ? err.message : String(err));
    return cloneCatalogue();
  }
}
