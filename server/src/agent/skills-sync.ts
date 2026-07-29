/**
 * Non-destructive synchronization of the per-project scientific skill catalogue.
 *
 * Each project keeps a manifest of the upstream hashes it last applied. A sync
 * can therefore update an unchanged skill while preserving both its enabled
 * state and any locally edited copy. Untracked/edited skills are never
 * overwritten; they are surfaced as update candidates instead.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "../config.ts";
import {
  ensureProjectExists,
  listProjects,
  resolvePaths,
  type ProjectPaths,
} from "../projects.ts";
import {
  isSkillDefaultDisabled,
  SKILL_NAME_RE,
  SKILLS_BRANCH,
  SKILLS_REPO,
  skillsDisabledDir,
} from "./skills.ts";

const MANIFEST_VERSION = 1;
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ManifestSkill {
  /** Upstream tree hash the local copy was last based on. */
  baseHash?: string;
  /** Most recent upstream tree hash observed for this skill. */
  upstreamHash?: string;
}

interface SkillSyncManifest {
  version: 1;
  repo: string;
  branch: string;
  upstreamCommit: string | null;
  lastCheckedAt: string | null;
  skills: Record<string, ManifestSkill>;
  updatesAvailable: string[];
  customized: string[];
  orphaned: string[];
  archived: string[];
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
  lastCheckedAt: string | null;
  updatesAvailable: string[];
  customized: string[];
  orphaned: string[];
  archived: string[];
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
  commit: string;
  cleanup: () => void;
}

interface SyncLogger {
  info: (data: unknown, message?: string) => void;
  warn: (data: unknown, message?: string) => void;
}

let syncQueue: Promise<void> = Promise.resolve();
let syncActive = false;
let scheduler: NodeJS.Timeout | null = null;

function manifestPath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "skills-sync.json");
}

function archivedSkillsDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "skills-archived");
}

function emptyManifest(): SkillSyncManifest {
  return {
    version: MANIFEST_VERSION,
    repo: SKILLS_REPO,
    branch: SKILLS_BRANCH,
    upstreamCommit: null,
    lastCheckedAt: null,
    skills: {},
    updatesAvailable: [],
    customized: [],
    orphaned: [],
    archived: [],
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

function readManifest(paths: ProjectPaths): SkillSyncManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(paths), "utf-8")) as Partial<
      SkillSyncManifest
    >;
    if (raw.version !== MANIFEST_VERSION) return emptyManifest();
    const skills: Record<string, ManifestSkill> = {};
    if (raw.skills && typeof raw.skills === "object") {
      for (const [name, value] of Object.entries(raw.skills)) {
        if (!SKILL_NAME_RE.test(name) || !value || typeof value !== "object") continue;
        const entry = value as ManifestSkill;
        skills[name] = {
          ...(typeof entry.baseHash === "string" ? { baseHash: entry.baseHash } : {}),
          ...(typeof entry.upstreamHash === "string"
            ? { upstreamHash: entry.upstreamHash }
            : {}),
        };
      }
    }
    return {
      version: MANIFEST_VERSION,
      repo: typeof raw.repo === "string" ? raw.repo : SKILLS_REPO,
      branch: typeof raw.branch === "string" ? raw.branch : SKILLS_BRANCH,
      upstreamCommit:
        typeof raw.upstreamCommit === "string" ? raw.upstreamCommit : null,
      lastCheckedAt: typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null,
      skills,
      updatesAvailable: stringArray(raw.updatesAvailable),
      customized: stringArray(raw.customized),
      orphaned: stringArray(raw.orphaned),
      archived: stringArray(raw.archived),
      ...(raw.lastResult ? { lastResult: raw.lastResult } : {}),
    };
  } catch {
    return emptyManifest();
  }
}

function writeManifest(paths: ProjectPaths, manifest: SkillSyncManifest): void {
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  const file = manifestPath(paths);
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
    lastCheckedAt: manifest.lastCheckedAt,
    updatesAvailable: [...manifest.updatesAvailable],
    customized: [...manifest.customized],
    orphaned: [...manifest.orphaned],
    archived: [...manifest.archived],
    lastResult: manifest.lastResult ?? null,
  };
}

export function getSkillSyncStatus(paths: ProjectPaths): SkillSyncStatus {
  return statusFromManifest(readManifest(paths));
}

function hashDirectory(root: string): string {
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

function installedSkills(paths: ProjectPaths): Map<string, InstalledSkill> {
  const installed = new Map<string, InstalledSkill>();
  for (const [name, dir] of listSkillDirs(paths.skillsDir)) {
    installed.set(name, { dir, state: "enabled" });
  }
  for (const [name, dir] of listSkillDirs(skillsDisabledDir(paths))) {
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

function destinationForNewSkill(paths: ProjectPaths, name: string): string {
  const base = isSkillDefaultDisabled(name) ? skillsDisabledDir(paths) : paths.skillsDir;
  return path.join(base, name);
}

/** Replace a directory without exposing a partially copied skill. */
function installSkillTree(
  paths: ProjectPaths,
  source: string,
  destination: string,
  expectedDestinationHash?: string,
): boolean {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stagingRoot = path.join(paths.kadyDir, "skill-sync-staging");
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
  paths: ProjectPaths,
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
  const archiveRoot = archivedSkillsDir(paths);
  fs.mkdirSync(archiveRoot, { recursive: true });
  let destination = path.join(archiveRoot, name);
  if (fs.existsSync(destination)) {
    destination = path.join(archiveRoot, `${name}-${Date.now()}-${crypto.randomUUID()}`);
  }
  fs.renameSync(installed.dir, destination);
  return true;
}

/**
 * Apply one already-downloaded catalogue to one project. Exported so sync
 * semantics can be tested without network access.
 */
export function syncProjectSkillsFromCatalogue(
  paths: ProjectPaths,
  catalogueSkillsDir: string,
  upstreamCommit: string,
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
  upstreamCommit: string,
): SkillSyncResult {
  const installed = installedSkills(paths);
  const loaded = readManifest(paths);
  const previous =
    loaded.repo === SKILLS_REPO && loaded.branch === SKILLS_BRANCH
      ? loaded
      : emptyManifest();

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

  for (const [name, source] of [...upstream.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const upstreamHash = source.hash;
    const local = installed.get(name);
    const oldEntry = previous.skills[name];

    if (!local) {
      installSkillTree(paths, source.dir, destinationForNewSkill(paths, name));
      nextSkills[name] = { baseHash: upstreamHash, upstreamHash };
      counts.added++;
      continue;
    }

    const localHash = hashDirectory(local.dir);
    if (localHash === upstreamHash) {
      nextSkills[name] = { baseHash: upstreamHash, upstreamHash };
      counts.unchanged++;
      continue;
    }

    if (oldEntry?.baseHash && localHash === oldEntry.baseHash) {
      if (installSkillTree(paths, source.dir, local.dir, localHash)) {
        nextSkills[name] = { baseHash: upstreamHash, upstreamHash };
        counts.updated++;
      } else {
        nextSkills[name] = { baseHash: oldEntry.baseHash, upstreamHash };
        customized.push(name);
        updatesAvailable.push(name);
        counts.preserved++;
      }
      continue;
    }

    nextSkills[name] = {
      ...(oldEntry?.baseHash ? { baseHash: oldEntry.baseHash } : {}),
      upstreamHash,
    };
    customized.push(name);
    if (!oldEntry?.baseHash || oldEntry.baseHash !== upstreamHash) {
      updatesAvailable.push(name);
    }
    counts.preserved++;
  }

  // A tracked skill removed upstream is archived only when its local tree is
  // still exactly the last applied upstream tree. Edited copies stay active.
  for (const [name, oldEntry] of Object.entries(previous.skills)) {
    if (upstream.has(name)) continue;
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
      nextSkills[name] = { baseHash: oldEntry.baseHash };
      counts.preserved++;
    } else {
      orphaned.push(name);
      customized.push(name);
      nextSkills[name] = {
        ...(oldEntry.baseHash ? { baseHash: oldEntry.baseHash } : {}),
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
    lastCheckedAt: new Date().toISOString(),
    skills: nextSkills,
    updatesAvailable: [...new Set(updatesAvailable)].sort(),
    customized: [...new Set(customized)].sort(),
    orphaned: [...new Set(orphaned)].sort(),
    archived: [...new Set([...previous.archived, ...archivedNow])].sort(),
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
  upstreamCommit: string,
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
  upstreamCommit: string,
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
  manifest.skills[name] = { baseHash: upstreamHash, upstreamHash };
  manifest.updatesAvailable = manifest.updatesAvailable.filter((item) => item !== name);
  manifest.customized = manifest.customized.filter((item) => item !== name);
  manifest.orphaned = manifest.orphaned.filter((item) => item !== name);
  writeManifest(paths, manifest);
  return statusFromManifest(manifest);
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      killSignal: "SIGTERM",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited with status ${code}`));
    });
  });
}

async function cloneCatalogue(): Promise<Catalogue> {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kady-skills-sync-"));
  try {
    await runGit([
      "clone",
      "--depth",
      "1",
      "--branch",
      SKILLS_BRANCH,
      `https://github.com/${SKILLS_REPO}.git`,
      tmpRoot,
    ]);
    const skillsDir = path.join(tmpRoot, "skills");
    if (!fs.existsSync(skillsDir)) throw new Error("Cloned catalogue has no skills directory");
    const commit = await runGit(["rev-parse", "HEAD"], tmpRoot);
    return {
      skillsDir,
      skills: indexCatalogue(skillsDir),
      commit,
      cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }
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
  let catalogue: Catalogue | null = null;
  try {
    catalogue = await cloneCatalogue();
    return work(catalogue);
  } finally {
    catalogue?.cleanup();
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
