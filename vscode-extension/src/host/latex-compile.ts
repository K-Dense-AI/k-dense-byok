import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";

export type LatexEngine = "pdflatex" | "xelatex" | "lualatex";

export interface LatexCompileSummary {
  success: boolean;
  engine: LatexEngine;
  command: string;
  commandLine: string;
  statusMessage: string;
  stdout: string;
  stderr: string;
  log: string;
  pdfUri?: vscode.Uri;
}

export interface LatexCompileDependencies {
  runCommand(
    command: string,
    args: string[],
    options: { cwd: string },
  ): Promise<LatexRunResult>;
  readTextFile(filePath: string): Promise<string | undefined>;
  fileExists(filePath: string): Promise<boolean>;
}

interface LatexRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

const defaultDependencies: LatexCompileDependencies = {
  runCommand: runCommandWithNode,
  async readTextFile(filePath) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
  },
  async fileExists(filePath) {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

export async function compileLatexDocument(
  resource: vscode.Uri,
  engine: LatexEngine,
  dependencies: LatexCompileDependencies = defaultDependencies,
): Promise<LatexCompileSummary> {
  const cwd = path.dirname(resource.fsPath);
  const fileName = path.basename(resource.fsPath);
  const baseName = fileName.replace(/\.[^.]+$/u, "");
  const pdfPath = path.join(cwd, `${baseName}.pdf`);
  const logPath = path.join(cwd, `${baseName}.log`);

  const latexmkArgs = [...getLatexmkArgs(engine), fileName];
  const latexmkAttempt = await dependencies.runCommand("latexmk", latexmkArgs, { cwd });

  if (!latexmkAttempt.notFound) {
    return finalizeLatexCompile(
      resource,
      engine,
      "latexmk",
      latexmkArgs,
      latexmkAttempt,
      pdfPath,
      logPath,
      dependencies,
    );
  }

  const engineArgs = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", fileName];
  const engineAttempt = await dependencies.runCommand(engine, engineArgs, { cwd });

  return finalizeLatexCompile(
    resource,
    engine,
    engine,
    engineArgs,
    engineAttempt,
    pdfPath,
    logPath,
    dependencies,
  );
}

function getLatexmkArgs(engine: LatexEngine) {
  const engineFlag = engine === "xelatex"
    ? "-xelatex"
    : engine === "lualatex"
      ? "-lualatex"
      : "-pdf";

  return [engineFlag, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"];
}

async function finalizeLatexCompile(
  resource: vscode.Uri,
  engine: LatexEngine,
  command: string,
  args: string[],
  runResult: LatexRunResult,
  pdfPath: string,
  logPath: string,
  dependencies: LatexCompileDependencies,
): Promise<LatexCompileSummary> {
  const log = (await dependencies.readTextFile(logPath)) ?? "";
  const pdfExists = await dependencies.fileExists(pdfPath);
  const success = runResult.exitCode === 0 && pdfExists;
  const pdfUri = pdfExists ? resource.with({ path: `${resource.path.replace(/\.[^.]+$/u, "")}.pdf` }) : undefined;
  const commandLine = [command, ...args].join(" ");

  return {
    success,
    engine,
    command,
    commandLine,
    statusMessage: success
      ? `Compilation succeeded with ${command}.`
      : `Compilation failed with ${command}. Review the log output below.`,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    log,
    pdfUri,
  };
}

async function runCommandWithNode(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<LatexRunResult> {
  const { spawn } = await import("node:child_process");

  return new Promise<LatexRunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        notFound: error.code === "ENOENT",
      });
    });

    child.on("close", (exitCode) => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}
