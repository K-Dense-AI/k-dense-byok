/**
 * User-driven skill management: install from a source, author a new skill, edit
 * one in place, and remove one.
 *
 * Fetching is delegated to `skills-fetch.ts` (the `skills` CLI) and every write
 * to a live skill directory goes through `skills-sync.ts`'s atomic
 * `installSkillTree`, so this module only decides *what* should happen: which
 * scope, which names, what provenance to record, and whether a removal needs a
 * tombstone.
 *
 * Installing is a two-step flow on purpose. `previewSkillSource` downloads to
 * staging and reports what the source actually contains; the caller then
 * confirms and `installStagedSkills` copies the chosen subset in. Skills are
 * instructions that run with the agent's full permissions, so the user gets to
 * see what they are taking before it lands.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
  asSkillRoot,
  findSkillDir,
  globalSkillRoot,
  projectSkillRoot,
  SKILL_NAME_RE,
  type SkillRoot,
  type SkillScopeRef,
} from "./skills.ts";
import {
  cacheKeyForSource,
  clearStaging,
  fetchSkills,
  readStagedLock,
  stagedSkillsDir,
  stagingDirFor,
  type SkillLockEntry,
} from "./skills-fetch.ts";
import {
  archivedSkillsDir,
  dropSkillFromManifest,
  getSkillProvenance,
  hashDirectory,
  installSkillTree,
  markSkillRemoved,
  recordSkillOrigin,
  setSkillUpdateAvailable,
} from "./skills-sync.ts";
import type { ProjectPaths } from "../projects.ts";

/**
 * Pi's own rule for skill names (`core/skills.ts` `validateName`), which is
 * stricter than the directory-safety check in `SKILL_NAME_RE`. Applied when we
 * create a name; skills that arrive from a source are validated by the loader
 * and surface as `problems` instead, so a slightly-off upstream name is
 * reported rather than silently rejected.
 */
const PI_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillOperationError {
  status: 400 | 404 | 409 | 502;
  detail: string;
}

export class SkillOperationFailure extends Error implements SkillOperationError {
  status: 400 | 404 | 409 | 502;
  constructor(status: 400 | 404 | 409 | 502, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
  detail: string;
}

function fail(status: 400 | 404 | 409 | 502, detail: string): never {
  throw new SkillOperationFailure(status, detail);
}

export function validateNewSkillName(name: string): void {
  if (!name) fail(400, "A skill name is required");
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    fail(400, `Skill names are at most ${MAX_SKILL_NAME_LENGTH} characters`);
  }
  if (!PI_SKILL_NAME_RE.test(name)) {
    fail(
      400,
      `Invalid skill name "${name}". Use lowercase letters, digits and single hyphens (e.g. "rna-seq-qc").`,
    );
  }
}

// --- preview / install ----------------------------------------------------

export interface PreviewedSkill {
  name: string;
  description: string;
  /** Files in the staged tree, as a rough size signal for the picker. */
  files: number;
  /** Where this exact skill came from, per the CLI's lock file. */
  source?: string;
  /** Already installed in the target scope. */
  installed: boolean;
  /** Installed in the other scope, where it may shadow or be shadowed. */
  conflictsWith?: "project" | "global";
}

export interface SkillSourcePreview {
  source: string;
  ref?: string;
  /** Opaque handle the install call passes back to reuse this download. */
  stagingKey: string;
  /**
   * Content fingerprint of the staged download. The install call echoes it to
   * say "install the bytes I was shown", which is what makes the confirmation
   * step meaningful. A missing or non-matching token means this staging dir is
   * not the one that was reviewed, so the source is downloaded again instead of
   * installing whatever the cache happens to hold.
   */
  stagingToken: string;
  skills: PreviewedSkill[];
  /** Loader complaints about the staged trees (malformed frontmatter, …). */
  problems: { name: string; message: string }[];
}

/** Fingerprint of every staged skill tree, order-independent. */
function stagingTokenFor(skillsDir: string): string {
  const names = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const hash = crypto.createHash("sha256");
  hash.update("kady-staging-v1\0");
  for (const name of names) {
    hash.update(`${name}\0${hashDirectory(path.join(skillsDir, name))}\0`);
  }
  return hash.digest("hex");
}

function countFiles(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else total++;
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable staging is reported by the caller's emptiness check */
  }
  return total;
}

function otherRoot(root: SkillRoot, paths: ProjectPaths): SkillRoot {
  return root.kind === "project" ? globalSkillRoot() : projectSkillRoot(paths);
}

/**
 * Download a source and describe it without installing anything.
 *
 * The whole source is fetched even when the user wants one skill, because the
 * picker needs real parsed names and descriptions — and reading them from the
 * staged trees is more robust than parsing the CLI's `--list` output.
 */
export async function previewSkillSource(
  paths: ProjectPaths,
  options: { source: string; ref?: string; scope?: string },
): Promise<SkillSourcePreview> {
  const source = options.source.trim();
  if (!source) fail(400, "A skill source is required");
  const ref = options.ref?.trim() || undefined;
  const root = options.scope === "global" ? globalSkillRoot() : projectSkillRoot(paths);
  const stagingKey = cacheKeyForSource(source, ref);

  let staged;
  try {
    staged = await fetchSkills({ source, ref, cacheKey: stagingKey });
  } catch (err) {
    fail(502, err instanceof Error ? err.message : `Could not fetch ${source}`);
  }

  const { skills, diagnostics } = loadSkillsFromDir({
    dir: staged.skillsDir,
    source: "project",
  });
  const lock = staged.lock;
  const other = otherRoot(root, paths);

  return {
    source,
    ...(ref ? { ref } : {}),
    stagingKey,
    stagingToken: stagingTokenFor(staged.skillsDir),
    skills: skills.map((skill) => {
      const conflict = findSkillDir(other, skill.name) ? other.kind : undefined;
      return {
        name: skill.name,
        description: skill.description,
        files: countFiles(path.join(staged.skillsDir, skill.name)),
        ...(lock[skill.name]?.source ? { source: lock[skill.name].source } : {}),
        installed: Boolean(findSkillDir(root, skill.name)),
        ...(conflict ? { conflictsWith: conflict } : {}),
      };
    }),
    problems: diagnostics.map((d) => ({
      name:
        d.collision?.name ?? (path.basename(path.dirname(d.path ?? "")) || "(unknown)"),
      message: d.message.trim(),
    })),
  };
}

export interface InstallStagedOptions {
  source: string;
  ref?: string;
  names: string[];
  scope?: string;
  /**
   * `stagingToken` from the preview the user confirmed. Present and matching →
   * the reviewed trees are installed from staging. Absent or stale → the source
   * is downloaded again, so an install that reviewed nothing cannot be served an
   * older copy left over in the cache.
   */
  stagingToken?: string;
  /** Overwrite a name that is already installed in the target scope. */
  replace?: boolean;
  /**
   * The caller has told the user these skills run with the agent's full
   * permissions and they accepted. Enforced here, not only in the UI: an
   * install is the moment third-party instructions enter the agent.
   */
  acknowledged?: boolean;
}

export interface InstallResult {
  installed: string[];
  /** Names skipped because they already exist and `replace` was not set. */
  conflicts: string[];
}

/**
 * Install named skills from an already-previewed download. Re-fetches when the
 * staging dir is gone (a restart, a manual clear, or a different worker), so a
 * confirmed install does not fail just because the cache went cold.
 */
export async function installStagedSkills(
  paths: ProjectPaths,
  options: InstallStagedOptions,
): Promise<InstallResult> {
  if (!options.acknowledged) {
    fail(400, "Installing a skill requires acknowledging that it runs with agent permissions");
  }
  const source = options.source.trim();
  if (!source) fail(400, "A skill source is required");
  const names = [...new Set(options.names.filter((n) => n && SKILL_NAME_RE.test(n)))];
  if (names.length === 0) fail(400, "Select at least one skill to install");

  const ref = options.ref?.trim() || undefined;
  const root = options.scope === "global" ? globalSkillRoot() : projectSkillRoot(paths);
  const stagingKey = cacheKeyForSource(source, ref);
  let skillsDir = stagedSkillsDir(stagingDirFor(stagingKey));
  let lock: Record<string, SkillLockEntry> = readStagedLock(stagingDirFor(stagingKey));

  const staleStaging =
    !options.stagingToken ||
    !fs.existsSync(skillsDir) ||
    stagingTokenFor(skillsDir) !== options.stagingToken ||
    names.some((name) => !fs.existsSync(path.join(skillsDir, name, "SKILL.md")));
  if (staleStaging) {
    try {
      const staged = await fetchSkills({ source, ref, names, cacheKey: stagingKey });
      skillsDir = staged.skillsDir;
      lock = staged.lock;
    } catch (err) {
      fail(502, err instanceof Error ? err.message : `Could not fetch ${source}`);
    }
  }

  const installed: string[] = [];
  const conflicts: string[] = [];
  for (const name of names) {
    const stagedSkill = path.join(skillsDir, name);
    if (!fs.existsSync(path.join(stagedSkill, "SKILL.md"))) {
      fail(404, `"${name}" is not present in ${source}`);
    }
    const existing = findSkillDir(root, name);
    if (existing && !options.replace) {
      conflicts.push(name);
      continue;
    }
    // Keep an existing skill's enabled/disabled placement on replacement;
    // a fresh install is enabled, because the user picked it by name.
    const destination = existing ?? path.join(root.skillsDir, name);
    installSkillTree(root, stagedSkill, destination);
    recordSkillOrigin(root, name, {
      origin: "registry",
      source: lock[name]?.source ?? source,
      ...(ref ? { ref } : {}),
      ...(lock[name]?.skillPath ? { skillPath: lock[name].skillPath } : {}),
      baseHash: hashDirectory(destination),
    });
    installed.push(name);
  }

  return { installed, conflicts };
}

// --- authoring ------------------------------------------------------------

const SKILL_TEMPLATE = (name: string, description: string): string =>
  `---
name: ${name}
description: ${description}
---

# ${name}

Describe what the agent should do when this skill is active.

## When to use

Spell out the situations that should trigger this skill. The description above
is what the model matches against, so keep it specific.

## Steps

1. First step
2. Second step
`;

export interface CreateSkillOptions {
  name: string;
  description?: string;
  scope?: string;
}

/** Author a new empty skill in a scope, ready for editing. */
export function createSkill(
  paths: ProjectPaths,
  options: CreateSkillOptions,
): { name: string; scope: SkillRoot["kind"] } {
  const name = options.name.trim().toLowerCase();
  validateNewSkillName(name);
  const description =
    options.description?.trim() || `Custom skill: ${name.replace(/-/g, " ")}`;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    fail(400, `Descriptions are at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const root = options.scope === "global" ? globalSkillRoot() : projectSkillRoot(paths);
  if (findSkillDir(root, name)) {
    fail(409, `A skill named "${name}" already exists in this scope`);
  }

  const dir = path.join(root.skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_TEMPLATE(name, description), "utf-8");
  recordSkillOrigin(root, name, { origin: "local", baseHash: hashDirectory(dir) });
  return { name, scope: root.kind };
}

/**
 * Overwrite a skill's SKILL.md. No manifest bookkeeping is needed: the tree
 * hash now differs from the recorded baseline, which is exactly how the sync
 * engine already recognises a locally edited skill.
 */
export function writeSkillSource(
  ref: SkillScopeRef,
  name: string,
  content: string,
): void {
  const root = asSkillRoot(ref);
  const dir = findSkillDir(root, name);
  if (!dir) fail(404, `No such skill: "${name}"`);
  if (typeof content !== "string" || !content.trim()) {
    fail(400, "SKILL.md content is required");
  }
  const file = path.join(dir, "SKILL.md");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// --- removal --------------------------------------------------------------

export interface RemoveResult {
  name: string;
  /** `archived` keeps a copy on disk; `deleted` does not. */
  disposition: "archived" | "deleted";
}

/**
 * Remove a skill from a scope.
 *
 * A catalogue skill is archived rather than deleted and its name is
 * tombstoned, because the catalogue still offers it and the next sync would
 * otherwise reinstall it — the removal would appear to undo itself. Skills the
 * user installed or wrote have no upstream that can resurrect them, so they are
 * deleted outright.
 */
export function removeSkill(ref: SkillScopeRef, name: string): RemoveResult {
  const root = asSkillRoot(ref);
  if (!SKILL_NAME_RE.test(name)) fail(400, `Invalid skill name "${name}"`);
  const dir = findSkillDir(root, name);
  if (!dir) fail(404, `No such skill: "${name}"`);

  const origin = getSkillProvenance(root, name)?.origin ?? "catalogue";
  if (origin === "catalogue") {
    const archiveRoot = archivedSkillsDir(root);
    fs.mkdirSync(archiveRoot, { recursive: true });
    let destination = path.join(archiveRoot, name);
    if (fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(dir, destination);
    markSkillRemoved(root, name);
    return { name, disposition: "archived" };
  }

  fs.rmSync(dir, { recursive: true, force: true });
  dropSkillFromManifest(root, name);
  return { name, disposition: "deleted" };
}

// --- update checks for user-installed skills -------------------------------

/**
 * Re-fetch a skill's own source into staging and return the staged tree.
 *
 * Deliberately a fresh download compared by hash rather than `skills update`:
 * staging is disposable, so this needs no trust in the CLI's lock mutation and
 * works the same for every source type.
 */
async function stageForSkill(
  ref: SkillScopeRef,
  name: string,
): Promise<{ dir: string; lock: Record<string, SkillLockEntry> }> {
  const root = asSkillRoot(ref);
  const provenance = getSkillProvenance(root, name);
  if (!provenance) fail(404, `No such skill: "${name}"`);
  if (provenance.origin === "local") {
    fail(400, `"${name}" was written here and has no source to update from`);
  }
  if (!provenance.source) {
    fail(400, `No source recorded for "${name}", so it cannot be updated`);
  }
  const cacheKey = cacheKeyForSource(provenance.source, provenance.ref);
  try {
    const staged = await fetchSkills({
      source: provenance.source,
      ...(provenance.ref ? { ref: provenance.ref } : {}),
      names: [name],
      cacheKey,
    });
    const dir = path.join(staged.skillsDir, name);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) {
      fail(404, `"${name}" is no longer present at ${provenance.source}`);
    }
    return { dir, lock: staged.lock };
  } catch (err) {
    if (err instanceof SkillOperationFailure) throw err;
    fail(502, err instanceof Error ? err.message : `Could not fetch ${provenance.source}`);
  }
}

export interface UpdateCheck {
  name: string;
  updateAvailable: boolean;
  source?: string;
}

/** Ask a user-installed skill's source whether it has changed. */
export async function checkSkillUpdate(
  ref: SkillScopeRef,
  name: string,
): Promise<UpdateCheck> {
  const root = asSkillRoot(ref);
  const local = findSkillDir(root, name);
  if (!local) fail(404, `No such skill: "${name}"`);
  const { dir } = await stageForSkill(root, name);
  const upstreamHash = hashDirectory(dir);
  const updateAvailable = hashDirectory(local) !== upstreamHash;
  setSkillUpdateAvailable(root, name, updateAvailable, upstreamHash);
  return {
    name,
    updateAvailable,
    ...(getSkillProvenance(root, name)?.source
      ? { source: getSkillProvenance(root, name)?.source }
      : {}),
  };
}

/** Replace a user-installed skill with the current copy from its source. */
export async function updateSkillFromSource(
  ref: SkillScopeRef,
  name: string,
): Promise<{ name: string; updated: boolean }> {
  const root = asSkillRoot(ref);
  const local = findSkillDir(root, name);
  if (!local) fail(404, `No such skill: "${name}"`);
  const provenance = getSkillProvenance(root, name);
  const { dir, lock } = await stageForSkill(root, name);
  installSkillTree(root, dir, local);
  recordSkillOrigin(root, name, {
    origin: "registry",
    source: lock[name]?.source ?? provenance?.source,
    ...(provenance?.ref ? { ref: provenance.ref } : {}),
    ...(lock[name]?.skillPath ? { skillPath: lock[name].skillPath } : {}),
    baseHash: hashDirectory(local),
  });
  return { name, updated: true };
}

/** Forget a source's staged download (frees the cache after an install). */
export function forgetSource(source: string, ref?: string): void {
  clearStaging(cacheKeyForSource(source, ref));
}
