/**
 * Generic dispatcher for scientific-file preview helpers (chem/structure/...).
 *
 * Mirrors the anndata_helper.py wiring in sandbox.ts, but generalized so new
 * preview kinds only need an entry in KIND_TO_SCRIPT plus a Python helper
 * script in server/src/helpers/. Routes registered in sandbox.ts consume
 * sciHelperFor()/runSciHelper() and translate the helper's exit code into an
 * HTTP status (see the anndata-summary/anndata-embedding.png routes for the
 * same 3/4/5 convention).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HELPERS_DIR, helperPython } from "../helpers-env.ts";

export type SciKind = "chem" | "structure" | "massspec" | "arrays";

const KIND_TO_SCRIPT: Record<string, string> = {
  chem: "chem_helper.py",
  structure: "structure_helper.py",
  massspec: "massspec_helper.py",
  arrays: "arrays_helper.py",
};

/** Absolute helper script path for a known kind, or null if the kind is unrecognized. */
export function sciHelperFor(kind: string): { script: string } | null {
  const file = KIND_TO_SCRIPT[kind];
  if (!file) return null;
  return { script: path.join(HELPERS_DIR, file) };
}

/** Spawns the helper script for `kind` with `subcommand` + args, returning its exit status and output. */
export function runSciHelper(
  kind: string,
  subcommand: "summarize" | "render",
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const helper = sciHelperFor(kind);
  if (!helper) return { status: 2, stdout: "", stderr: `unknown kind: ${kind}` };
  const res = spawnSync(helperPython(), [helper.script, subcommand, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
