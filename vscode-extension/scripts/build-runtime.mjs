import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const outputRoot = path.join(extensionRoot, "dist", "runtime");

const runtimeFiles = [
  "server.py",
  "initialize_kdense_workspace.sh",
  "start_kdense_backend.sh",
  "stop_kdense_backend.sh",
  "prep_sandbox.py",
  "litellm_config.yaml",
  "pyproject.toml",
  "kady_agent/__init__.py",
  "kady_agent/agent.py",
  "kady_agent/gemini_settings.py",
  "kady_agent/mcps.py",
  "kady_agent/runtime_paths.py",
  "kady_agent/utils.py",
  "kady_agent/instructions/main_agent.md",
  "kady_agent/instructions/gemini_cli.md",
  "kady_agent/tools/__init__.py",
  "kady_agent/tools/gemini_cli.py",
];

await rm(outputRoot, { force: true, recursive: true });

for (const relativePath of runtimeFiles) {
  const sourcePath = path.join(repoRoot, relativePath);
  const outputPath = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });

  if (relativePath === "pyproject.toml") {
    const source = await readFile(sourcePath, "utf8");
    const sanitized = source.replace(/^readme\s*=\s*".*"\s*$/m, "").replace(/\n{3,}/g, "\n\n");
    await writeFile(outputPath, sanitized, "utf8");
    continue;
  }

  await cp(sourcePath, outputPath, { force: true, recursive: false });
}

await Promise.all([
  chmod(path.join(outputRoot, "initialize_kdense_workspace.sh"), 0o755),
  chmod(path.join(outputRoot, "start_kdense_backend.sh"), 0o755),
  chmod(path.join(outputRoot, "stop_kdense_backend.sh"), 0o755),
]);
