/**
 * Generic dispatcher for scientific-file preview helpers (chem/structure/...).
 *
 * Mirrors the anndata_helper.py wiring in sandbox.ts, but generalized so new
 * preview kinds only need an entry in KIND_TO_SCRIPT plus a Python helper
 * script in server/src/helpers/. Routes registered in sandbox.ts consume
 * sciHelperFor()/runSciHelper() and translate the helper's exit code into an
 * HTTP status (see the anndata-summary/anndata-embedding.png routes for the
 * same 3/4/5 convention).
 *
 * Helpers run asynchronously with a hard timeout. spawnSync would block the
 * whole Node event loop for as long as the helper runs, so one pathological
 * file froze the entire backend — chat, streaming and all — with no way out.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { HELPERS_DIR, helperPython } from "../helpers-env.ts";

export type SciKind = "chem" | "structure" | "massspec" | "arrays" | "imaging";

const KIND_TO_SCRIPT: Record<string, string> = {
  chem: "chem_helper.py",
  structure: "structure_helper.py",
  massspec: "massspec_helper.py",
  arrays: "arrays_helper.py",
  imaging: "imaging_helper.py",
};

/** Wall-clock ceiling for a single preview helper invocation. */
export const HELPER_TIMEOUT_MS = 60_000;
const HELPER_MAX_BUFFER = 64 * 1024 * 1024;

export interface HelperResult {
  /** Helper exit-code contract: 0 ok, 3 deps missing, 4 not found, 5 bad value, 1 other. */
  status: number;
  stdout: string;
  stderr: string;
  /** True when the helper was killed for exceeding HELPER_TIMEOUT_MS. */
  timedOut: boolean;
}

/** Absolute helper script path for a known kind, or null if the kind is unrecognized. */
export function sciHelperFor(kind: string): { script: string } | null {
  const file = KIND_TO_SCRIPT[kind];
  if (!file) return null;
  return { script: path.join(HELPERS_DIR, file) };
}

/** Run a helper script off the event loop, killed if it outlives `timeoutMs`. */
export function runHelperScript(
  script: string,
  args: string[],
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<HelperResult> {
  return new Promise((resolve) => {
    execFile(
      helperPython(),
      [script, ...args],
      {
        encoding: "utf-8",
        maxBuffer: HELPER_MAX_BUFFER,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ status: 0, stdout, stderr, timedOut: false });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        const timedOut = err.killed === true || err.signal === "SIGKILL";
        let detail = stderr ?? "";
        if (timedOut) {
          detail = `Preview helper timed out after ${Math.round(timeoutMs / 1000)}s`;
        } else if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          detail = "Preview helper produced too much output";
        }
        resolve({
          status: typeof err.code === "number" ? err.code : 1,
          stdout: stdout ?? "",
          stderr: detail || err.message || "Preview helper failed",
          timedOut,
        });
      },
    );
  });
}

/** Runs the helper script for `kind` with `subcommand` + args. */
export function runSciHelper(
  kind: string,
  subcommand: "summarize" | "render",
  args: string[],
): Promise<HelperResult> {
  const helper = sciHelperFor(kind);
  if (!helper) {
    return Promise.resolve({
      status: 2,
      stdout: "",
      stderr: `unknown kind: ${kind}`,
      timedOut: false,
    });
  }
  return runHelperScript(helper.script, [subcommand, ...args]);
}
