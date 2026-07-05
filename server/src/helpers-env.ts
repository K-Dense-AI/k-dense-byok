/**
 * Reproducible Python environment for the backend's helper CLIs (server/src/helpers/*.py).
 *
 * Mirrors the `syncSandboxVenv` pattern in sandbox-seed.ts, but for the helper
 * scripts the backend itself shells out to (currently anndata_helper.py) rather
 * than the per-project agent sandbox. Keeping these deps in their own
 * uv-managed venv means helper previews no longer depend on system python3
 * happening to have rdkit/gemmi/anndata/etc. installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to server/src/helpers (holds the Python CLIs + pyproject.toml). */
export const HELPERS_DIR = path.join(__dirname, "helpers");

/** Interpreter for the Python helper CLIs. Prefers an explicit override, then the
 *  uv-managed helper venv, then system python3. */
export function helperPython(): string {
  if (process.env.KADY_PYTHON) return process.env.KADY_PYTHON;
  const venvPy = path.join(HELPERS_DIR, ".venv", "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return "python3";
}

function uvBinary(): string | null {
  for (const c of ["uv", path.join(os.homedir(), ".local", "bin", "uv")]) {
    if (spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
  }
  return null;
}

/** Best-effort `uv sync` of the helper venv. Returns false when uv is unavailable
 *  or the sync fails; callers treat that as "previews degrade to deps-missing". */
export function syncHelperVenv(): boolean {
  const uv = uvBinary();
  if (!uv) return false;
  const res = spawnSync(uv, ["sync"], {
    cwd: HELPERS_DIR,
    stdio: "ignore",
    timeout: 15 * 60 * 1000,
  });
  return res.status === 0;
}
