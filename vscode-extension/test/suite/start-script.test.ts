import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

suite("start.sh startup contract", () => {
  test("continues past missing kady_agent/.env using shell defaults", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kdense-start-sh-"));
    const sourceStartScript = path.resolve(__dirname, "../../../../start.sh");
    const logPath = path.join(tempRoot, "commands.log");

    try {
      await fs.mkdir(path.join(tempRoot, "web"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "kady_agent"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "bin"), { recursive: true });
      await fs.copyFile(sourceStartScript, path.join(tempRoot, "start.sh"));
      await fs.chmod(path.join(tempRoot, "start.sh"), 0o755);

      for (const command of ["uv", "npm", "node", "gemini"]) {
        await writeExecutable(
          path.join(tempRoot, "bin", command),
          `#!/usr/bin/env bash
printf '%s\n' "${command} $*" >> "$KDENSE_TEST_LOG"
exit 0
`,
        );
      }

      const result = await runCommand("bash", ["./start.sh"], {
        cwd: tempRoot,
        env: {
          ...process.env,
          PATH: `${path.join(tempRoot, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          KDENSE_TEST_LOG: logPath,
        },
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout + result.stderr, /kady_agent\/.env not found/i);
      const log = await fs.readFile(logPath, "utf8");
      assert.match(log, /uv sync --quiet/);
      assert.match(log, /uv run python prep_sandbox.py/);
      assert.match(log, /npm install --silent/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
