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
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findUv, firstRunnable } from "./binaries.ts";
import { createHash } from "node:crypto";
import { runtimePaths } from "./runtime-paths.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to server/src/helpers (holds the Python CLIs + pyproject.toml). */
export const HELPERS_DIR = path.join(__dirname, "helpers");

// Installed resources are immutable, so the lock digest is computed once.
let lockDigest: string | undefined;

export function helperEnvironmentDir(): string {
  if (!runtimePaths().packaged) return path.join(HELPERS_DIR, ".venv");
  if (!lockDigest) {
    const hash = createHash("sha256");
    for (const file of ["pyproject.toml", "uv.lock"]) hash.update(fs.readFileSync(path.join(HELPERS_DIR, file)));
    lockDigest = hash.digest("hex").slice(0, 20);
  }
  return path.join(runtimePaths().cache, "helpers", lockDigest);
}

/** Interpreter for the Python helper CLIs. Prefers an explicit override, then the
 *  uv-managed helper venv, then a system Python. */
export function helperPython(): string {
  if (process.env.KADY_PYTHON) return process.env.KADY_PYTHON;
  const venvPy =
    process.platform === "win32"
      ? path.join(helperEnvironmentDir(), "Scripts", "python.exe")
      : path.join(helperEnvironmentDir(), "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;
  if (process.platform === "win32") return firstRunnable(["python", "py"]) ?? "python";
  return "python3";
}

/** Best-effort `uv sync` of the helper venv. Returns false when uv is unavailable
 *  or the sync fails; callers treat that as "previews degrade to deps-missing". */
export function syncHelperVenv(): boolean {
  const uv = findUv();
  if (!uv) return false;
  const res = spawnSync(uv, ["sync"], {
    cwd: HELPERS_DIR,
    stdio: "ignore",
    timeout: 15 * 60 * 1000,
  });
  return res.status === 0;
}
