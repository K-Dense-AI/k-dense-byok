/**
 * Async LaTeX compilation.
 *
 * Replaces the old spawnSync flow (which blocked the event loop for up to
 * 60s per compile). Uses latexmk when available (single command, handles
 * bibtex/biber + reruns), otherwise falls back to a multi-pass plan so
 * cross-references and bibliographies still resolve. Always compiles with
 * -synctex=1 so the editor can do source<->PDF sync.
 *
 * Concurrent compile requests for the same target share one in-flight
 * promise (coalescing) so a double-fired Cmd+Enter can't stack processes.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasBinary } from "../binaries.ts";
import { apiRelative } from "../sandbox-fs.ts";

const execFileAsync = promisify(execFile);

export const LATEX_ENGINES: ReadonlySet<string> = new Set([
  "pdflatex",
  "xelatex",
  "lualatex",
]);

export interface CompileOutcome {
  success: boolean;
  pdf_path: string | null; // relative to sandboxRoot
  log: string;
  /** Final engine transcript, excluding warnings resolved by earlier passes. */
  diagnostics_log?: string;
  errors: string[];
  synctex: boolean;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_LOG_BUFFER = 16 * 1024 * 1024;
const MAX_LOG_RETURN = 64_000;

/** Keep the first error as well as the final summary when bounding a log. */
function clampLog(log: string): string {
  if (log.length <= MAX_LOG_RETURN) return log;
  const marker = "\n\n[Compilation log truncated]\n\n";
  const half = Math.floor((MAX_LOG_RETURN - marker.length) / 2);
  return log.slice(0, half) + marker + log.slice(-half);
}

/** Which bibliography tool does this source need, if any? Ignores comments. */
export function detectBibTool(src: string): "bibtex" | "biber" | null {
  src = src.replace(/(?<!\\)%.*$/gm, "");
  const biblatex = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
  for (const match of src.matchAll(biblatex)) {
    if (match[2].split(",").some((p) => p.trim() === "biblatex")) {
      return /\bbackend\s*=\s*bibtex\b/.test(match[1] ?? "") ? "bibtex" : "biber";
    }
  }
  if (/\\addbibresource\b/.test(src)) return "biber";
  if (/\\bibliography\s*\{/.test(src)) return "bibtex";
  return null;
}

/**
 * The user's own latexmk configuration, if any. Compiling runs with `-norc`
 * because latexmk otherwise executes a `latexmkrc` found in the document's
 * folder as Perl — and received LaTeX projects (Overleaf exports, a
 * collaborator's zip) routinely ship one. The user's personal rc file is
 * theirs, so it is loaded explicitly.
 */
export function userLatexmkrc(home = os.homedir(), env = process.env): string | null {
  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  for (const candidate of [path.join(xdg, "latexmk", "latexmkrc"), path.join(home, ".latexmkrc")]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

/** Ordered list of commands (argv arrays) to run in the target's directory. */
export function buildCompilePlan(opts: {
  engine: string;
  targetAbs: string;
  hasLatexmk: boolean;
  bibTool: "bibtex" | "biber" | null;
  userRc?: string | null;
}): string[][] {
  if (opts.hasLatexmk) {
    return [[
      "latexmk",
      "-norc",
      ...(opts.userRc ? ["-r", opts.userRc] : []),
      `-${opts.engine}`,
      "-interaction=nonstopmode",
      "-cd",
      "-file-line-error",
      "-synctex=1",
      opts.targetAbs,
    ]];
  }
  const base = path.basename(opts.targetAbs);
  const stem = base.replace(/\.(tex|latex)$/, "");
  const engine = [
    opts.engine,
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    base,
  ];
  const plan: string[][] = [engine];
  if (opts.bibTool) plan.push([opts.bibTool, stem], engine);
  plan.push(engine);
  return plan;
}

const inflight = new Map<string, Promise<CompileOutcome>>();

/** Compile `targetAbs` with `engine`; paths in the result are sandbox-relative. */
export function compileLatex(
  targetAbs: string,
  engine: string,
  sandboxRoot: string,
  opts?: { useLatexmk?: boolean; signal?: AbortSignal },
): Promise<CompileOutcome> {
  const existing = inflight.get(targetAbs);
  if (existing) return existing;
  const p = doCompile(targetAbs, engine, sandboxRoot, opts).finally(() => {
    inflight.delete(targetAbs);
  });
  inflight.set(targetAbs, p);
  return p;
}

async function doCompile(
  targetAbs: string,
  engine: string,
  sandboxRoot: string,
  opts?: { useLatexmk?: boolean; signal?: AbortSignal },
): Promise<CompileOutcome> {
  const workDir = path.dirname(targetAbs);
  const stem = path.basename(targetAbs).replace(/\.(tex|latex)$/, "");
  const pdfAbs = path.join(workDir, stem + ".pdf");
  // The fallback plan passes the bare file name, which an engine would parse
  // as an option if it began with "-".
  if (path.basename(targetAbs).startsWith("-")) {
    return {
      success: false,
      pdf_path: null,
      log: "",
      errors: ["File names starting with '-' cannot be compiled; rename the file."],
      synctex: false,
    };
  }
  const src = fs.readFileSync(targetAbs, "utf-8");
  const useLatexmk = opts?.useLatexmk ?? hasBinary("latexmk");
  const plan = buildCompilePlan({
    engine,
    targetAbs,
    hasLatexmk: useLatexmk,
    bibTool: detectBibTool(src),
    userRc: useLatexmk ? userLatexmkrc() : null,
  });

  let log = "";
  let diagnosticsLog = "";
  const failures: string[] = [];
  for (const [cmd, ...args] of plan) {
    // A closed tab or a superseded compile shouldn't keep burning CPU through
    // the remaining passes; the signal also kills the running engine.
    if (opts?.signal?.aborted) {
      return {
        success: false,
        pdf_path: null,
        log: clampLog(log + "\nCompilation cancelled."),
        errors: ["Cancelled"],
        synctex: false,
      };
    }
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: workDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_LOG_BUFFER,
        encoding: "utf-8",
        killSignal: "SIGKILL",
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      log += `\n--- ${cmd} ---\n${stdout}${stderr}`;
      if (cmd !== "bibtex" && cmd !== "biber") diagnosticsLog = `${stdout}${stderr}`;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        code?: number | string;
      };
      const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      log += `\n--- ${cmd} ---\n${output}`;
      if (cmd !== "bibtex" && cmd !== "biber") diagnosticsLog = output;
      if (e.code === "ENOENT") {
        return {
          success: false,
          pdf_path: null,
          log: clampLog(log + `\n${cmd} not found. Install a TeX distribution with ${cmd} and add it to PATH.`),
          errors: [`${cmd} not found`],
          synctex: false,
        };
      }
      if (e.killed || opts?.signal?.aborted) {
        const cancelled = opts?.signal?.aborted === true;
        return {
          success: false,
          pdf_path: null,
          log: clampLog(
            cancelled
              ? log + "\nCompilation cancelled."
              : log + `\nCompilation timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
          ),
          errors: [cancelled ? "Cancelled" : "Timeout"],
          synctex: false,
        };
      }
      const failure = `${cmd} failed (exit ${e.code ?? 1}). See the compilation log for details.`;
      failures.push(failure);
      log += `\n${failure}\n`;
      // bibtex/biber failures shouldn't kill the run — the engine passes
      // that follow surface the real problem in the log. Engine failures
      // end the plan (later passes would only repeat the same error).
      if (cmd !== "bibtex" && cmd !== "biber") break;
    }
  }

  // Every pass in buildCompilePlan passes -file-line-error, which makes TeX
  // print "file:line: message" instead of the classic "! message" marker
  // (in both the terminal output and the .log transcript) — match both so
  // errors are still surfaced regardless of which style a given engine used.
  const errors = [...new Set([...log.matchAll(/^(?:! |.+?:\d+:\s+)(.+)/gm)].map((m) => m[1]))];
  const success = failures.length === 0 && fs.existsSync(pdfAbs);
  // Bibliography failures often have no TeX-style file/line diagnostic. They
  // must not disappear when a later engine pass exits successfully.
  if (!success) errors.push(...failures);
  if (!success && !errors.length) errors.push("Compilation did not produce a PDF.");
  // latexmk may run several engine passes internally. Its .log is the final
  // engine transcript, whereas stdout also contains already-resolved warnings.
  if (useLatexmk) {
    try { diagnosticsLog = fs.readFileSync(path.join(workDir, stem + ".log"), "utf-8"); }
    catch { /* Keep the command output if the engine never started. */ }
  }
  return {
    success,
    pdf_path: success ? apiRelative(sandboxRoot, pdfAbs) : null,
    log: clampLog(log),
    diagnostics_log: clampLog(diagnosticsLog),
    errors,
    synctex: success && fs.existsSync(path.join(workDir, stem + ".synctex.gz")),
  };
}
