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
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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
  errors: string[];
  synctex: boolean;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_LOG_BUFFER = 16 * 1024 * 1024;
const MAX_LOG_RETURN = 8_000;

/** Which bibliography tool does this source need, if any? Ignores comments. */
export function detectBibTool(src: string): "bibtex" | "biber" | null {
  if (
    /^[^%\n]*\\addbibresource\b/m.test(src) ||
    /^[^%\n]*\\usepackage(\[[^\]]*\])?\{biblatex\}/m.test(src)
  ) {
    return "biber";
  }
  if (/^[^%\n]*\\bibliography\{/m.test(src)) return "bibtex";
  return null;
}

/** Ordered list of commands (argv arrays) to run in the target's directory. */
export function buildCompilePlan(opts: {
  engine: string;
  targetAbs: string;
  hasLatexmk: boolean;
  bibTool: "bibtex" | "biber" | null;
}): string[][] {
  if (opts.hasLatexmk) {
    return [[
      "latexmk",
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

let latexmkAvailable: boolean | null = null;
function hasLatexmk(): boolean {
  if (latexmkAvailable === null) {
    latexmkAvailable = spawnSync("which", ["latexmk"]).status === 0;
  }
  return latexmkAvailable;
}

const inflight = new Map<string, Promise<CompileOutcome>>();

/** Compile `targetAbs` with `engine`; paths in the result are sandbox-relative. */
export function compileLatex(
  targetAbs: string,
  engine: string,
  sandboxRoot: string,
  opts?: { useLatexmk?: boolean },
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
  opts?: { useLatexmk?: boolean },
): Promise<CompileOutcome> {
  const workDir = path.dirname(targetAbs);
  const stem = path.basename(targetAbs).replace(/\.(tex|latex)$/, "");
  const pdfAbs = path.join(workDir, stem + ".pdf");
  const src = fs.readFileSync(targetAbs, "utf-8");
  const plan = buildCompilePlan({
    engine,
    targetAbs,
    hasLatexmk: opts?.useLatexmk ?? hasLatexmk(),
    bibTool: detectBibTool(src),
  });

  let log = "";
  let lastStatus = 0;
  for (const [cmd, ...args] of plan) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: workDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_LOG_BUFFER,
        encoding: "utf-8",
        killSignal: "SIGKILL",
      });
      log += `${stdout}${stderr}`;
      lastStatus = 0;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        code?: number | string;
      };
      log += `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (e.code === "ENOENT") {
        return {
          success: false,
          pdf_path: null,
          log: `LaTeX compiler not found. Install TeX Live or add ${cmd} to PATH.`,
          errors: [`${cmd} not found`],
          synctex: false,
        };
      }
      if (e.killed) {
        return {
          success: false,
          pdf_path: null,
          log: log + "\nCompilation timed out after 60 seconds.",
          errors: ["Timeout"],
          synctex: false,
        };
      }
      lastStatus = typeof e.code === "number" ? e.code : 1;
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
  const errors = [...log.matchAll(/^(?:! |\S+:\d+: )(.+)/gm)].map((m) => m[1]);
  const success = lastStatus === 0 && fs.existsSync(pdfAbs);
  return {
    success,
    pdf_path: fs.existsSync(pdfAbs) ? path.relative(sandboxRoot, pdfAbs) : null,
    log: log.length > MAX_LOG_RETURN ? log.slice(-MAX_LOG_RETURN) : log,
    errors,
    synctex: fs.existsSync(path.join(workDir, stem + ".synctex.gz")),
  };
}
