/**
 * Non-destructive synchronization of the per-project scientific skill catalogue.
 *
 * Each project keeps a manifest of the upstream hashes it last applied. A sync
 * can therefore update an unchanged skill while preserving both its enabled
 * state and any locally edited copy. Untracked/edited skills are never
 * overwritten; they are surfaced as update candidates instead.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_ID, SKILLS_BRANCH, SKILLS_REPO } from "../config.ts";
import {
  ensureProjectExists,
  listProjects,
  resolvePaths,
  type ProjectPaths,
} from "../projects.ts";
import { fetchCatalogue } from "./skills-fetch.ts";
import {
  asSkillRoot,
  isSkillDefaultDisabled,
  SKILL_NAME_RE,
  type SkillScopeRef,
} from "./skills.ts";

const MANIFEST_VERSION = 2;
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Where a skill came from. `catalogue` skills are the ones the daily sync
 * owns; `registry` skills were installed by the user from some other source
 * and are only ever touched on explicit request; `local` skills were authored
 * here and have no upstream at all.
 */
export type SkillOrigin = "catalogue" | "registry" | "local";

interface ManifestSkill {
  /** Upstream tree hash the local copy was last based on. */
  baseHash?: string;
  /** Most recent upstream tree hash observed for this skill. */
  upstreamHash?: string;
  /** Defaults to `catalogue` for entries written before origins existed. */
  origin?: SkillOrigin;
  /** Registry provenance, mirrored from the CLI's lock file. */
  source?: string;
  ref?: string;
  skillPath?: string;
}

interface SkillSyncManifest {
  version: 2;
  repo: string;
  branch: string;
  upstreamCommit: string | null;
  /**
   * Digest over the catalogue's per-skill hashes. Replaces the commit id: the
   * CLI stages file copies rather than a git checkout, so there is no commit to
   * record on the normal path.
   */
  catalogueDigest: string | null;
  lastCheckedAt: string | null;
  skills: Record<string, ManifestSkill>;
  updatesAvailable: string[];
  customized: string[];
  orphaned: string[];
  archived: string[];
  /**
   * Catalogue skills the user deleted. Without these the next sync would see a
   * skill present upstream and absent locally and silently reinstall it — the
   * deletion would appear to undo itself a day later.
   */
  removed: string[];
  lastResult?: SkillSyncCounts;
}

export interface SkillSyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  preserved: number;
  archived: number;
}

export interface SkillSyncStatus {
  repo: string;
  branch: string;
  upstreamCommit: string | null;
  catalogueDigest: string | null;
  lastCheckedAt: string | null;
  updatesAvailable: string[];
  customized: string[];
  orphaned: string[];
  archived: string[];
  removed: string[];
  lastResult: SkillSyncCounts | null;
}

export interface SkillSyncResult extends SkillSyncStatus {
  counts: SkillSyncCounts;
}

interface InstalledSkill {
  dir: string;
  state: "enabled" | "disabled";
}

interface UpstreamSkill {
  dir: string;
  hash: string;
}

interface Catalogue {
  skillsDir: string;
  skills: Map<string, UpstreamSkill>;
  commit: string | null;
  cleanup: () => void;
}

interface SyncLogger {
  info: (data: unknown, message?: string) => void;
  warn: (data: unknown, message?: string) => void;
}

let syncQueue: Promise<void> = Promise.resolve();
let syncActive = false;
let scheduler: NodeJS.Timeout | null = null;

function manifestPath(ref: SkillScopeRef): string {
  return path.join(asSkillRoot(ref).stateDir, "skills-sync.json");
}

export function archivedSkillsDir(ref: SkillScopeRef): string {
  return asSkillRoot(ref).archivedDir;
}

function emptyManifest(): SkillSyncManifest {
  return {
    version: MANIFEST_VERSION,
    repo: SKILLS_REPO,
    branch: SKILLS_BRANCH,
    upstreamCommit: null,
    catalogueDigest: null,
    lastCheckedAt: null,
    skills: {},
    updatesAvailable: [],
    customized: [],
    orphaned: [],
    archived: [],
    removed: [],
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

const ORIGINS = new Set<SkillOrigin>(["catalogue", "registry", "local"]);

function readManifest(ref: SkillScopeRef): SkillSyncManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(ref), "utf-8")) as Partial<
      SkillSyncManifest
    > & { version?: number };
    // v1 is forward-compatible: it holds the same hashes and simply predates
    // origins and tombstones, so it is migrated rather than discarded —
    // dropping it would re-flag every locally edited skill as "update
    // available" on the first run after upgrading.
    if (raw.version !== MANIFEST_VERSION && raw.version !== 1) return emptyManifest();
    const skills: Record<string, ManifestSkill> = {};
    if (raw.skills && typeof raw.skills === "object") {
      for (const [name, value] of Object.entries(raw.skills)) {
        if (!SKILL_NAME_RE.test(name) || !value || typeof value !== "object") continue;
        const entry = value as ManifestSkill;
        const origin =
          entry.origin && ORIGINS.has(entry.origin) ? entry.origin : "catalogue";
        skills[name] = {
          ...(typeof entry.baseHash === "string" ? { baseHash: entry.baseHash } : {}),
          ...(typeof entry.upstreamHash === "string"
            ? { upstreamHash: entry.upstreamHash }
            : {}),
          origin,
          ...(typeof entry.source === "string" ? { source: entry.source } : {}),
          ...(typeof entry.ref === "string" ? { ref: entry.ref } : {}),
          ...(typeof entry.skillPath === "string" ? { skillPath: entry.skillPath } : {}),
        };
      }
    }
    return {
      version: MANIFEST_VERSION,
      repo: typeof raw.repo === "string" ? raw.repo : SKILLS_REPO,
      branch: typeof raw.branch === "string" ? raw.branch : SKILLS_BRANCH,
      upstreamCommit:
        typeof raw.upstreamCommit === "string" ? raw.upstreamCommit : null,
      catalogueDigest:
        typeof raw.catalogueDigest === "string" ? raw.catalogueDigest : null,
      lastCheckedAt: typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null,
      skills,
      updatesAvailable: stringArray(raw.updatesAvailable),
      customized: stringArray(raw.customized),
      orphaned: stringArray(raw.orphaned),
      archived: stringArray(raw.archived),
      removed: stringArray(raw.removed),
      ...(raw.lastResult ? { lastResult: raw.lastResult } : {}),
    };
  } catch {
    return emptyManifest();
  }
}

function writeManifest(ref: SkillScopeRef, manifest: SkillSyncManifest): void {
  fs.mkdirSync(asSkillRoot(ref).stateDir, { recursive: true });
  const file = manifestPath(ref);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function statusFromManifest(manifest: SkillSyncManifest): SkillSyncStatus {
  return {
    repo: manifest.repo,
    branch: manifest.branch,
    upstreamCommit: manifest.upstreamCommit,
    catalogueDigest: manifest.catalogueDigest,
    lastCheckedAt: manifest.lastCheckedAt,
    updatesAvailable: [...manifest.updatesAvailable],
    customized: [...manifest.customized],
    orphaned: [...manifest.orphaned],
    archived: [...manifest.archived],
    removed: [...manifest.removed],
    lastResult: manifest.lastResult ?? null,
  };
}

export function getSkillSyncStatus(ref: SkillScopeRef): SkillSyncStatus {
  return statusFromManifest(readManifest(ref));
}

/**
 * Record a catalogue skill as intentionally removed. The name is remembered
 * because the catalogue still offers it: without a tombstone the next sync
 * would treat it as missing-and-wanted and reinstall it, so the deletion would
 * quietly undo itself.
 */
export function markSkillRemoved(ref: SkillScopeRef, name: string): void {
  const manifest = readManifest(ref);
  delete manifest.skills[name];
  if (!manifest.removed.includes(name)) manifest.removed.push(name);
  manifest.removed.sort();
  manifest.updatesAvailable = manifest.updatesAvailable.filter((n) => n !== name);
  manifest.customized = manifest.customized.filter((n) => n !== name);
  manifest.orphaned = manifest.orphaned.filter((n) => n !== name);
  writeManifest(ref, manifest);
}

/**
 * Forget a skill entirely. For registry/local skills there is no upstream that
 * could resurrect them, so no tombstone is needed.
 */
export function dropSkillFromManifest(ref: SkillScopeRef, name: string): void {
  const manifest = readManifest(ref);
  delete manifest.skills[name];
  manifest.updatesAvailable = manifest.updatesAvailable.filter((n) => n !== name);
  manifest.customized = manifest.customized.filter((n) => n !== name);
  manifest.orphaned = manifest.orphaned.filter((n) => n !== name);
  writeManifest(ref, manifest);
}

/** Record a skill installed from a non-catalogue source (or authored locally). */
export function recordSkillOrigin(
  scope: SkillScopeRef,
  name: string,
  entry: {
    origin: Exclude<SkillOrigin, "catalogue">;
    source?: string;
    ref?: string;
    skillPath?: string;
    baseHash?: string;
  },
): void {
  const manifest = readManifest(scope);
  manifest.skills[name] = {
    origin: entry.origin,
    ...(entry.baseHash ? { baseHash: entry.baseHash } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.ref ? { ref: entry.ref } : {}),
    ...(entry.skillPath ? { skillPath: entry.skillPath } : {}),
  };
  // Installing over a tombstoned name is a deliberate replacement of the
  // deletion, not a resurrection of the catalogue's copy.
  manifest.removed = manifest.removed.filter((n) => n !== name);
  manifest.updatesAvailable = manifest.updatesAvailable.filter((n) => n !== name);
  writeManifest(scope, manifest);
}

/**
 * Flag (or clear) an available update for one skill. Used by the on-demand
 * check for user-installed skills, which are never auto-updated: a
 * third-party skill is instructions the agent will follow, so a new version
 * gets a badge and waits for the user rather than landing mid-project.
 */
export function setSkillUpdateAvailable(
  ref: SkillScopeRef,
  name: string,
  available: boolean,
  upstreamHash?: string,
): void {
  const manifest = readManifest(ref);
  const entry = manifest.skills[name];
  if (!entry) return;
  if (upstreamHash) manifest.skills[name] = { ...entry, upstreamHash };
  const rest = manifest.updatesAvailable.filter((n) => n !== name);
  manifest.updatesAvailable = available ? [...rest, name].sort() : rest;
  manifest.lastCheckedAt = new Date().toISOString();
  writeManifest(ref, manifest);
}

/** Per-skill origin as recorded in the manifest (absent → catalogue). */
export function getSkillOrigins(ref: SkillScopeRef): Record<string, SkillOrigin> {
  const out: Record<string, SkillOrigin> = {};
  for (const [name, entry] of Object.entries(readManifest(ref).skills)) {
    out[name] = entry.origin ?? "catalogue";
  }
  return out;
}

/** Provenance for one skill, for the UI's source badge and update routing. */
export function getSkillProvenance(
  scope: SkillScopeRef,
  name: string,
): { origin: SkillOrigin; source?: string; ref?: string; skillPath?: string } | null {
  const entry = readManifest(scope).skills[name];
  if (!entry) return null;
  return {
    origin: entry.origin ?? "catalogue",
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.ref ? { ref: entry.ref } : {}),
    ...(entry.skillPath ? { skillPath: entry.skillPath } : {}),
  };
}

export function hashDirectory(root: string): string {
  const hash = crypto.createHash("sha256");
  hash.update("kady-skill-tree-v1\0");

  const walk = (dir: string, relativeDir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        walk(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      }
    }
  };

  walk(root, "");
  return hash.digest("hex");
}

function listSkillDirs(dir: string): Map<string, string> {
  const skills = new Map<string, string>();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
      const skillDir = path.join(dir, entry.name);
      if (fs.existsSync(path.join(skillDir, "SKILL.md"))) {
        skills.set(entry.name, skillDir);
      }
    }
  } catch {
    // Missing catalogue/installed directory is an empty set.
  }
  return skills;
}

function installedSkills(ref: SkillScopeRef): Map<string, InstalledSkill> {
  const installed = new Map<string, InstalledSkill>();
  const root = asSkillRoot(ref);
  for (const [name, dir] of listSkillDirs(root.skillsDir)) {
    installed.set(name, { dir, state: "enabled" });
  }
  for (const [name, dir] of listSkillDirs(root.disabledDir)) {
    if (!installed.has(name)) installed.set(name, { dir, state: "disabled" });
  }
  return installed;
}

function indexCatalogue(skillsDir: string): Map<string, UpstreamSkill> {
  return new Map(
    [...listSkillDirs(skillsDir)].map(([name, dir]) => [
      name,
      { dir, hash: hashDirectory(dir) },
    ]),
  );
}

function destinationForNewSkill(ref: SkillScopeRef, name: string): string {
  const root = asSkillRoot(ref);
  // The default-disabled policy is a property of the seeded catalogue, so a
  // user-level install is always enabled: it was asked for by name.
  const base =
    root.kind === "project" && isSkillDefaultDisabled(name)
      ? root.disabledDir
      : root.skillsDir;
  return path.join(base, name);
}

/** Replace a directory without exposing a partially copied skill. */
export function installSkillTree(
  ref: SkillScopeRef,
  source: string,
  destination: string,
  expectedDestinationHash?: string,
): boolean {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stagingRoot = path.join(asSkillRoot(ref).stateDir, "skill-sync-staging");
  fs.mkdirSync(stagingRoot, { recursive: true });
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const staged = path.join(stagingRoot, `${path.basename(destination)}.new-${suffix}`);
  const backup = path.join(stagingRoot, `${path.basename(destination)}.old-${suffix}`);
  try {
    fs.cpSync(source, staged, { recursive: true });
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }

  // An editor or another Kady process may have changed/moved the skill while
  // the upstream tree was being staged. Abort instead of overwriting that race.
  if (
    expectedDestinationHash &&
    (!fs.existsSync(destination) ||
      hashDirectory(destination) !== expectedDestinationHash)
  ) {
    fs.rmSync(staged, { recursive: true, force: true });
    return false;
  }

  if (!fs.existsSync(destination)) {
    fs.renameSync(staged, destination);
    return true;
  }

  fs.renameSync(destination, backup);
  try {
    fs.renameSync(staged, destination);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(destination, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  return true;
}

function archiveSkill(
  ref: SkillScopeRef,
  name: string,
  installed: InstalledSkill,
  expectedHash: string,
): boolean {
  if (
    !fs.existsSync(installed.dir) ||
    hashDirectory(installed.dir) !== expectedHash
  ) {
    return false;
  }
  const archiveRoot = archivedSkillsDir(ref);
  fs.mkdirSync(archiveRoot, { recursive: true });
  let destination = path.join(archiveRoot, name);
  if (fs.existsSync(destination)) {
    destination = path.join(archiveRoot, `${name}-${Date.now()}-${crypto.randomUUID()}`);
  }
  fs.renameSync(installed.dir, destination);
  return true;
}

/** Digest identifying a catalogue by content, since there is no commit id. */
function catalogueDigestOf(upstream: Map<string, UpstreamSkill>): string {
  const hash = crypto.createHash("sha256");
  hash.update("kady-catalogue-v1\0");
  for (const [name, skill] of [...upstream.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(`${name}\0${skill.hash}\0`);
  }
  return hash.digest("hex");
}

/**
 * Apply one already-downloaded catalogue to one project. Exported so sync
 * semantics can be tested without network access.
 */
export function syncProjectSkillsFromCatalogue(
  paths: ProjectPaths,
  catalogueSkillsDir: string,
  upstreamCommit: string | null,
): SkillSyncResult {
  return syncProjectSkillsFromIndex(
    paths,
    indexCatalogue(catalogueSkillsDir),
    upstreamCommit,
  );
}

function syncProjectSkillsFromIndex(
  paths: ProjectPaths,
  upstream: Map<string, UpstreamSkill>,
  upstreamCommit: string | null,
): SkillSyncResult {
  const installed = installedSkills(paths);
  const loaded = readManifest(paths);
  const previous =
    loaded.repo === SKILLS_REPO && loaded.branch === SKILLS_BRANCH
      ? loaded
      : emptyManifest();
  // Deletions are honoured across syncs; a user who removes a catalogue skill
  // must not find it back tomorrow.
  const removed = new Set(previous.removed);

  const nextSkills: Record<string, ManifestSkill> = {};
  const updatesAvailable: string[] = [];
  const customized: string[] = [];
  const orphaned: string[] = [];
  const archivedNow: string[] = [];
  const counts: SkillSyncCounts = {
    added: 0,
    updated: 0,
    unchanged: 0,
    preserved: 0,
    archived: 0,
  };

  // User-installed and locally authored skills are outside the catalogue's
  // authority: carry their manifest entries through untouched.
  for (const [name, entry] of Object.entries(previous.skills)) {
    if ((entry.origin ?? "catalogue") !== "catalogue" && installed.has(name)) {
      nextSkills[name] = entry;
    }
  }

  for (const [name, source] of [...upstream.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (removed.has(name)) continue;
    const upstreamHash = source.hash;
    const local = installed.get(name);
    const oldEntry = previous.skills[name];

    // A name the user installed from elsewhere wins over the catalogue's copy;
    // overwriting it would silently replace their skill with a different one.
    if (local && oldEntry && (oldEntry.origin ?? "catalogue") !== "catalogue") {
      continue;
    }

    if (!local) {
      installSkillTree(paths, source.dir, destinationForNewSkill(paths, name));
      nextSkills[name] = { baseHash: upstreamHash, upstreamHash, origin: "catalogue" };
      counts.added++;
      continue;
    }

    const localHash = hashDirectory(local.dir);
    if (localHash === upstreamHash) {
      nextSkills[name] = { baseHash: upstreamHash, upstreamHash, origin: "catalogue" };
      counts.unchanged++;
      continue;
    }

    if (oldEntry?.baseHash && localHash === oldEntry.baseHash) {
      if (installSkillTree(paths, source.dir, local.dir, localHash)) {
        nextSkills[name] = { baseHash: upstreamHash, upstreamHash, origin: "catalogue" };
        counts.updated++;
      } else {
        nextSkills[name] = {
          baseHash: oldEntry.baseHash,
          upstreamHash,
          origin: "catalogue",
        };
        customized.push(name);
        updatesAvailable.push(name);
        counts.preserved++;
      }
      continue;
    }

    nextSkills[name] = {
      ...(oldEntry?.baseHash ? { baseHash: oldEntry.baseHash } : {}),
      upstreamHash,
      origin: "catalogue",
    };
    customized.push(name);
    if (!oldEntry?.baseHash || oldEntry.baseHash !== upstreamHash) {
      updatesAvailable.push(name);
    }
    counts.preserved++;
  }

  // A tracked catalogue skill removed upstream is archived only when its local
  // tree is still exactly the last applied upstream tree. Edited copies stay
  // active. Skills of another origin were never the catalogue's to retire.
  for (const [name, oldEntry] of Object.entries(previous.skills)) {
    if (upstream.has(name) || (oldEntry.origin ?? "catalogue") !== "catalogue") continue;
    const local = installed.get(name);
    if (!local) continue;
    const localHash = hashDirectory(local.dir);
    if (oldEntry.baseHash && localHash === oldEntry.baseHash) {
      if (archiveSkill(paths, name, local, localHash)) {
        archivedNow.push(name);
        counts.archived++;
        continue;
      }
      orphaned.push(name);
      customized.push(name);
      nextSkills[name] = { baseHash: oldEntry.baseHash, origin: "catalogue" };
      counts.preserved++;
    } else {
      orphaned.push(name);
      customized.push(name);
      nextSkills[name] = {
        ...(oldEntry.baseHash ? { baseHash: oldEntry.baseHash } : {}),
        origin: "catalogue",
      };
      counts.preserved++;
    }
  }

  // Skills not represented by the upstream manifest are project-local
  // customizations. They remain installed and are never retirement candidates.
  for (const name of installed.keys()) {
    if (!upstream.has(name) && !(name in previous.skills)) customized.push(name);
  }

  const manifest: SkillSyncManifest = {
    version: MANIFEST_VERSION,
    repo: SKILLS_REPO,
    branch: SKILLS_BRANCH,
    upstreamCommit,
    catalogueDigest: catalogueDigestOf(upstream),
    lastCheckedAt: new Date().toISOString(),
    skills: nextSkills,
    updatesAvailable: [...new Set(updatesAvailable)].sort(),
    customized: [...new Set(customized)].sort(),
    orphaned: [...new Set(orphaned)].sort(),
    archived: [...new Set([...previous.archived, ...archivedNow])].sort(),
    removed: [...removed].sort(),
    lastResult: counts,
  };
  writeManifest(paths, manifest);
  return { ...statusFromManifest(manifest), counts };
}

/**
 * Explicitly replace one project skill with the downloaded upstream copy.
 * Its enabled/disabled location is preserved.
 */
export function replaceProjectSkillFromCatalogue(
  paths: ProjectPaths,
  name: string,
  catalogueSkillsDir: string,
  upstreamCommit: string | null,
): SkillSyncStatus {
  return replaceProjectSkillFromIndex(
    paths,
    name,
    indexCatalogue(catalogueSkillsDir),
    upstreamCommit,
  );
}

function replaceProjectSkillFromIndex(
  paths: ProjectPaths,
  name: string,
  upstream: Map<string, UpstreamSkill>,
  upstreamCommit: string | null,
): SkillSyncStatus {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid skill name "${name}"`);
  const source = upstream.get(name);
  if (!source) throw new Error(`No such upstream skill: "${name}"`);

  const local = installedSkills(paths).get(name);
  const destination = local?.dir ?? destinationForNewSkill(paths, name);
  installSkillTree(paths, source.dir, destination);
  const upstreamHash = source.hash;
  const manifest = readManifest(paths);
  manifest.repo = SKILLS_REPO;
  manifest.branch = SKILLS_BRANCH;
  manifest.upstreamCommit = upstreamCommit;
  manifest.lastCheckedAt = new Date().toISOString();
  manifest.skills[name] = { baseHash: upstreamHash, upstreamHash, origin: "catalogue" };
  manifest.updatesAvailable = manifest.updatesAvailable.filter((item) => item !== name);
  manifest.customized = manifest.customized.filter((item) => item !== name);
  manifest.orphaned = manifest.orphaned.filter((item) => item !== name);
  // Taking the upstream copy is an explicit undelete.
  manifest.removed = manifest.removed.filter((item) => item !== name);
  writeManifest(paths, manifest);
  return statusFromManifest(manifest);
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = syncQueue.then(work, work);
  syncQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function withRemoteCatalogue<T>(work: (catalogue: Catalogue) => T): Promise<T> {
  syncActive = true;
  let cleanup: (() => void) | null = null;
  try {
    const fetched = await fetchCatalogue();
    cleanup = fetched.cleanup;
    return work({
      skillsDir: fetched.skillsDir,
      skills: indexCatalogue(fetched.skillsDir),
      commit: fetched.commit,
      cleanup: fetched.cleanup,
    });
  } finally {
    cleanup?.();
    syncActive = false;
  }
}

export function isSkillSyncActive(): boolean {
  return syncActive;
}

export function syncProjectSkillsFromRemote(paths: ProjectPaths): Promise<SkillSyncResult> {
  return enqueue(() =>
    withRemoteCatalogue((catalogue) =>
      syncProjectSkillsFromIndex(paths, catalogue.skills, catalogue.commit),
    ),
  );
}

export function replaceProjectSkillFromRemote(
  paths: ProjectPaths,
  name: string,
): Promise<SkillSyncStatus> {
  return enqueue(() =>
    withRemoteCatalogue((catalogue) => {
      syncProjectSkillsFromIndex(paths, catalogue.skills, catalogue.commit);
      return replaceProjectSkillFromIndex(
        paths,
        name,
        catalogue.skills,
        catalogue.commit,
      );
    }),
  );
}

function syncIntervalMs(): number {
  const configured = Number(process.env.KADY_SKILLS_SYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? configured
    : DEFAULT_SYNC_INTERVAL_MS;
}

function isDue(paths: ProjectPaths, now: number): boolean {
  const checked = getSkillSyncStatus(paths).lastCheckedAt;
  if (!checked) return true;
  const checkedAt = Date.parse(checked);
  return !Number.isFinite(checkedAt) || now - checkedAt >= syncIntervalMs();
}

export function syncAllProjectSkillsFromRemote(options?: {
  force?: boolean;
}): Promise<{ projects: number; results: Record<string, SkillSyncResult> }> {
  return enqueue(async () => {
    ensureProjectExists(DEFAULT_PROJECT_ID);
    const now = Date.now();
    const projects = listProjects()
      .filter((project) => !project.archived)
      .map((project) => resolvePaths(project.id))
      .filter((paths) => options?.force || isDue(paths, now));
    if (projects.length === 0) return { projects: 0, results: {} };

    return withRemoteCatalogue((catalogue) => {
      const results: Record<string, SkillSyncResult> = {};
      for (const paths of projects) {
        results[paths.id] = syncProjectSkillsFromIndex(
          paths,
          catalogue.skills,
          catalogue.commit,
        );
      }
      return { projects: projects.length, results };
    });
  });
}

/**
 * Start a non-blocking launch sync and repeat at the configured daily cadence.
 * The timer is unref'd so it cannot keep the backend alive during shutdown.
 */
export function startAutomaticSkillSync(logger: SyncLogger): () => void {
  const run = (): void => {
    void syncAllProjectSkillsFromRemote()
      .then(({ projects }) => {
        if (projects > 0) logger.info({ projects }, "scientific skills synchronized");
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "scientific skill synchronization failed",
        );
      });
  };

  queueMicrotask(run);
  if (!scheduler) {
    scheduler = setInterval(run, syncIntervalMs());
    scheduler.unref();
  }
  return () => {
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
  };
}
