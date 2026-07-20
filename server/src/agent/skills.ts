/**
 * Per-project skill seeding + listing.
 *
 * Skills are placed in `<sandbox>/.pi/skills/` so Pi's DefaultResourceLoader
 * (cwd = sandbox) auto-discovers and the agent activates them natively — no
 * orchestrator passthrough. The catalogue is the same K-Dense repo as before,
 * and the SKILL.md format is unchanged (Pi-compatible).
 *
 * Fast path: copy an existing sibling project's skills (local I/O). Slow path:
 * shallow-clone the repo once.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import type { ToggleResult } from "./capability-state.ts";

const SKILLS_REPO = process.env.KADY_SKILLS_REPO ?? "K-Dense-AI/scientific-agent-skills";
const SKILLS_SUBPATH = "skills";
const SKILLS_BRANCH = process.env.KADY_SKILLS_BRANCH ?? "main";
const DEFAULT_DISABLED_MIGRATION = "package-skills-disabled-v1";

/**
 * Package-reference skills add standing context that current models generally
 * do not need. Keep them installed so users can opt in from Settings, but seed
 * them into the disabled directory for new projects.
 *
 * Workflow, data-source, and platform skills remain enabled. Modal and
 * HypoGeniC are intentional exceptions: although broader than libraries, they
 * are package-backed and should also default to disabled.
 */
const DEFAULT_DISABLED_SKILLS = new Set([
  "aeon",
  "anndata",
  "arboreto",
  "astropy",
  "biopython",
  "bioservices",
  "cellxgene-census",
  "cirq",
  "cobrapy",
  "dask",
  "datamol",
  "deepchem",
  "deeptools",
  "esm",
  "etetoolkit",
  "flowio",
  "fluidsim",
  "geniml",
  "geopandas",
  "gget",
  "gtars",
  "histolab",
  "hypogenic",
  "lamindb",
  "markitdown",
  "matchms",
  "matplotlib",
  "medchem",
  "modal",
  "molfeat",
  "networkx",
  "neurokit2",
  "pathml",
  "pennylane",
  "polars",
  "polars-bio",
  "pufferlib",
  "pydeseq2",
  "pydicom",
  "pyhealth",
  "pylabrobot",
  "pymatgen",
  "pymc",
  "pymoo",
  "pyopenms",
  "pysam",
  "pytdc",
  "pytorch-lightning",
  "pyzotero",
  "qiskit",
  "qutip",
  "rdkit",
  "scanpy",
  "scikit-bio",
  "scikit-learn",
  "scikit-survival",
  "scvelo",
  "scvi-tools",
  "seaborn",
  "shap",
  "simpy",
  "stable-baselines3",
  "statsmodels",
  "sympy",
  "tiledbvcf",
  "timesfm-forecasting",
  "torch-geometric",
  "torchdrug",
  "transformers",
  "umap-learn",
  "vaex",
  "zarr-python",
]);

function countSkillDirs(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md")),
    ).length;
  } catch {
    return 0;
  }
}

export function skillsDisabledDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "skills-disabled");
}

function countInstalledSkills(paths: ProjectPaths): number {
  return countSkillDirs(paths.skillsDir) + countSkillDirs(skillsDisabledDir(paths));
}

function defaultDisabledMigrationMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "migrations", DEFAULT_DISABLED_MIGRATION);
}

/**
 * Apply the package-skill default once to an existing project. The marker is
 * written only after skills exist and all moves finish, so a later explicit
 * user enable is preserved.
 */
export function applyDefaultSkillStates(paths: ProjectPaths): void {
  const marker = defaultDisabledMigrationMarker(paths);
  if (fs.existsSync(marker) || countInstalledSkills(paths) === 0) return;

  const disabledDir = skillsDisabledDir(paths);
  for (const name of DEFAULT_DISABLED_SKILLS) {
    const src = path.join(paths.skillsDir, name);
    const dest = path.join(disabledDir, name);
    if (!fs.existsSync(path.join(src, "SKILL.md")) || fs.existsSync(dest)) continue;
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(src, dest);
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "", "utf-8");
}

/** Another project's enabled/disabled dirs that have skills (copy fast path). */
function findSiblingSkillDirs(excludeId: string): string[] | null {
  if (!fs.existsSync(PROJECTS_ROOT)) return null;
  for (const child of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === excludeId) continue;
    const piDir = path.join(PROJECTS_ROOT, child.name, "sandbox", ".pi");
    const candidates = [path.join(piDir, "skills"), path.join(piDir, "skills-disabled")];
    if (candidates.some((candidate) => countSkillDirs(candidate) > 0)) return candidates;
  }
  return null;
}

function copySkillDirs(srcDir: string, paths: ProjectPaths): number {
  if (!fs.existsSync(srcDir)) return 0;
  let copied = 0;
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const src = path.join(srcDir, d.name);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const enabled = path.join(paths.skillsDir, d.name);
    const disabled = path.join(skillsDisabledDir(paths), d.name);
    if (fs.existsSync(enabled) || fs.existsSync(disabled)) continue; // preserve user state/customizations
    const destDir = DEFAULT_DISABLED_SKILLS.has(d.name)
      ? skillsDisabledDir(paths)
      : paths.skillsDir;
    const dest = path.join(destDir, d.name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    copied++;
  }
  return copied;
}

/** Shallow-clone the catalogue repo; returns its skills dir + the tmp root to delete. */
function cloneCatalogue(): { skillsDir: string; tmpRoot: string } | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-skills-"));
  const res = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", SKILLS_BRANCH, `https://github.com/${SKILLS_REPO}.git`, tmp],
    { encoding: "utf-8", stdio: "pipe" },
  );
  const skillsDir = path.join(tmp, SKILLS_SUBPATH);
  if (res.status !== 0 || !fs.existsSync(skillsDir)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  return { skillsDir, tmpRoot: tmp };
}

/**
 * Ensure a project's skills dir is populated. Returns the number of skills.
 * `allowRemote=false` skips the network clone (fast path only).
 */
export function seedProjectSkills(paths: ProjectPaths, allowRemote = true): number {
  if (countInstalledSkills(paths) > 0) {
    applyDefaultSkillStates(paths);
    return countInstalledSkills(paths);
  }

  const sibling = findSiblingSkillDirs(paths.id);
  if (sibling) {
    for (const sourceDir of sibling) copySkillDirs(sourceDir, paths);
    if (countInstalledSkills(paths) > 0) {
      applyDefaultSkillStates(paths);
      return countInstalledSkills(paths);
    }
  }
  if (allowRemote) {
    const catalogue = cloneCatalogue();
    if (catalogue) {
      try {
        copySkillDirs(catalogue.skillsDir, paths);
      } finally {
        fs.rmSync(catalogue.tmpRoot, { recursive: true, force: true });
      }
    }
  }
  applyDefaultSkillStates(paths);
  return countInstalledSkills(paths);
}

/** List installed skills for the project (parsed SKILL.md frontmatter). */
export function listProjectSkills(paths: ProjectPaths): Skill[] {
  if (!fs.existsSync(paths.skillsDir)) return [];
  return loadSkillsFromDir({ dir: paths.skillsDir, source: "project" }).skills;
}

/** Skill directory names: no separators, no dot-dot. */
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Installed-but-disabled skills (parsed SKILL.md frontmatter). */
export function listDisabledSkills(paths: ProjectPaths): Skill[] {
  const dir = skillsDisabledDir(paths);
  if (!fs.existsSync(dir)) return [];
  return loadSkillsFromDir({ dir, source: "project" }).skills;
}

/** Raw SKILL.md text from whichever location holds the skill; null if absent. */
export function readSkillSource(paths: ProjectPaths, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  for (const base of [paths.skillsDir, skillsDisabledDir(paths)]) {
    const f = path.join(base, name, "SKILL.md");
    if (fs.existsSync(f)) {
      try {
        return fs.readFileSync(f, "utf-8");
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function moveSkill(fromDir: string, toDir: string, name: string): ToggleResult {
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: `Invalid skill name "${name}"` };
  }
  const src = path.join(fromDir, name);
  const dest = path.join(toDir, name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return { ok: false, status: 404, detail: `No such skill in this state: "${name}"` };
  }
  if (fs.existsSync(dest)) {
    return { ok: false, status: 409, detail: `A skill named "${name}" already exists at the target` };
  }
  fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true };
}

export function disableSkill(paths: ProjectPaths, name: string): ToggleResult {
  return moveSkill(paths.skillsDir, skillsDisabledDir(paths), name);
}

export function enableSkill(paths: ProjectPaths, name: string): ToggleResult {
  return moveSkill(skillsDisabledDir(paths), paths.skillsDir, name);
}
