import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "server", "package.json"));
const ts = require("typescript");
const manifest = JSON.parse(await fs.readFile(path.join(repo, "packaging", "runtimes.json"), "utf8"));
const pkg = JSON.parse(await fs.readFile(path.join(repo, "server", "package.json"), "utf8"));
const target = process.env.KADY_BUILD_TARGET || `${process.platform}-${process.arch}`;
if (target !== `${process.platform}-${process.arch}`) throw new Error("Build each distribution on its matching OS and architecture so native dependencies match.");
const runtimes = manifest.targets[target];
if (!runtimes) throw new Error("Unsupported distribution target: " + target);
const bundle = path.join(repo, "dist", target, "bundle");
const resources = path.join(bundle, "resources");
const cache = path.join(repo, "dist", "downloads");
await fs.mkdir(cache, { recursive: true });
await fs.rm(bundle, { recursive: true, force: true });
await fs.mkdir(resources, { recursive: true });

export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${signal || code})`)));
  });
}
async function sha(file) { const hash = crypto.createHash("sha256"); const { createReadStream } = await import("node:fs"); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest("hex"); }
async function download(spec) {
  if (!/^[a-f0-9]{64}$/.test(spec.sha256) || new URL(spec.url).protocol !== "https:") throw new Error("Invalid runtime lock entry");
  const file = path.join(cache, spec.sha256.slice(0, 16) + "-" + path.basename(new URL(spec.url).pathname));
  try { if (await sha(file) === spec.sha256) return file; } catch { /* Download once. */ }
  console.log("Downloading", path.basename(file));
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body) throw new Error("Runtime download failed: " + response.status);
  const tmp = file + ".tmp";
  try {
    await pipeline(response.body, createWriteStream(tmp));
    if (await sha(tmp) !== spec.sha256) throw new Error("Runtime checksum mismatch: " + path.basename(file));
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
  return file;
}
async function extract(file, destination) {
  await fs.mkdir(destination, { recursive: true });
  if (file.endsWith(".7z.exe")) await run(file, ["-y", "-o" + destination]);
  else if (file.endsWith(".zip")) await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:KADY_ARCHIVE -DestinationPath $env:KADY_EXTRACT -Force"], { env: { ...process.env, KADY_ARCHIVE: file, KADY_EXTRACT: destination } });
  else await run("tar", ["-xzf", file, "-C", destination]);
}
async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) { const found = await findFile(file, name); if (found) return found; }
  }
}
for (const [name, spec] of Object.entries(runtimes)) {
  const tmp = await fs.mkdtemp(path.join(cache, "extract-"));
  try {
    await extract(await download(spec), tmp);
    const destination = path.join(resources, name);
    if (name === "node") {
      const [root] = await fs.readdir(tmp); await fs.cp(path.join(tmp, root), destination, { recursive: true, verbatimSymlinks: true });
    } else if (name === "rg" || name === "fd") {
      const source = await findFile(tmp, name + (process.platform === "win32" ? ".exe" : ""));
      if (!source) throw new Error("Missing " + name);
      // Keep the release's licenses and notices beside its executable.
      await fs.cp(path.dirname(source), destination, { recursive: true, verbatimSymlinks: true });
    } else if (name === "uv") {
      await fs.mkdir(destination, { recursive: true });
      for (const binary of ["uv", "uvx"]) {
        const filename = binary + (process.platform === "win32" ? ".exe" : "");
        const source = await findFile(tmp, filename); if (!source) throw new Error("Missing " + filename);
        await fs.copyFile(source, path.join(destination, filename)); if (process.platform !== "win32") await fs.chmod(path.join(destination, filename), 0o755);
      }
    } else await fs.cp(tmp, destination, { recursive: true, verbatimSymlinks: true });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

// Explicit source allowlist: never package a working checkout, .env, projects,
// credentials, local virtualenvs, node caches, or personal skills.
async function copyCode(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules" || /\.(test|spec)\./.test(entry.name)) continue;
    const src = path.join(source, entry.name), dst = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyCode(src, dst);
    else if (entry.isFile()) {
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        // Retain resource filenames: Pi and child packages resolve .ts paths.
        // The shipped files contain JavaScript; Node's built-in TS loader
        // accepts it without a development-time tsx dependency.
        const code = ts.transpileModule(await fs.readFile(src, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true } }).outputText;
        await fs.writeFile(dst, code);
      } else await fs.copyFile(src, dst);
    } else throw new Error("Unexpected symlink in application sources: " + src);
  }
}
for (const rel of ["server/src", "server/pi-packages", "server/scripts", "web/src/lib", "web/src/data"]) await copyCode(path.join(repo, rel), path.join(resources, rel));
for (const rel of ["env-file.mjs", "server/package.json", "server/package-lock.json"]) await fs.copyFile(path.join(repo, rel), path.join(resources, rel));
await fs.writeFile(path.join(resources, "web", "package.json"), '{"type":"module"}\n');
for (const name of ["bootstrap.mjs", "guard.mjs"]) await fs.copyFile(path.join(repo, "packaging", "runtime", name), path.join(resources, name));
await fs.copyFile(path.join(repo, "packaging", "runtimes.json"), path.join(resources, "runtimes.json"));
const nodeDir = path.join(resources, "node", process.platform === "win32" ? "" : "bin");
const node = path.join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
const npm = path.join(resources, "node", process.platform === "win32" ? "node_modules" : "lib/node_modules", "npm", "bin", "npm-cli.js");
const env = { ...process.env, PATH: nodeDir + path.delimiter + process.env.PATH };
await run(node, [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(resources, "server"), env });
if (!process.argv.includes("--skip-web-build")) await run(node, [path.join(repo, "web/node_modules/next/dist/bin/next"), "build"], { cwd: path.join(repo, "web"), env: { ...env, NEXT_TELEMETRY_DISABLED: "1" } });
const standalone = path.join(repo, "web", ".next", "standalone");
await fs.cp(standalone, path.join(resources, "frontend"), { recursive: true, verbatimSymlinks: true });
await fs.cp(path.join(repo, "web", "public"), path.join(resources, "frontend", "public"), { recursive: true });
await fs.cp(path.join(repo, "web", ".next", "static"), path.join(resources, "frontend", ".next", "static"), { recursive: true });
// Next traces an .env if present. Packaging must exclude every such file.
async function removeEnvs(dir) { for (const item of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.name === ".env" || item.name.startsWith(".env.")) await fs.rm(file, { force: true }); else if (item.isDirectory()) await removeEnvs(file); } }
await removeEnvs(path.join(resources, "frontend"));
const buildLauncher = (output, gui) => run(process.env.KADY_GO || "go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${pkg.version}${gui ? " -H windowsgui" : ""}`, "-o", output, "."], { cwd: path.join(repo, "packaging", "launcher"), env: { ...process.env, CGO_ENABLED: "0" } });
// Windows ties console use to the binary: kady.exe is the console CLI
// (`kady status`, `kady logs` print and are waited for), kadyw.exe the
// windowless build the Start-menu shortcuts open.
await buildLauncher(path.join(bundle, process.platform === "win32" ? "kady.exe" : "kady"), false);
if (process.platform === "win32") await buildLauncher(path.join(bundle, "kadyw.exe"), true);
await fs.writeFile(path.join(resources, "distribution.json"), JSON.stringify({ version: pkg.version, target, node: manifest.nodeVersion, uv: manifest.uvVersion }, null, 2) + "\n");
await fs.writeFile(path.join(bundle, "README.txt"), "Open Kady to launch the app in your browser. Settings > Services offers setup, logs and shutdown.\nCommand line: kady start | stop | status | logs | import /path/to/checkout\nProjects and credentials are stored separately and survive application upgrades.\n");
for (const name of ["LICENSE", "NOTICE"]) { try { await fs.copyFile(path.join(repo, name), path.join(bundle, name)); } catch (e) { if (e.code !== "ENOENT") throw e; } }
await fs.cp(path.join(repo, "packaging", "licenses"), path.join(resources, "licenses"), { recursive: true });
// Both dependency trees and their original license files stay in the bundle.
await fs.writeFile(path.join(bundle, "THIRD-PARTY-NOTICES.txt"), "Includes Node.js (MIT and bundled dependency licenses), uv (MIT/Apache-2.0), ripgrep and fd (MIT/Unlicense), Git (GPL-2.0), the Go runtime (BSD), and npm dependencies. See resources/licenses, resources/node/LICENSE, resources/git, resources/rg, resources/fd and each node_modules package for license notices. Exact runtime versions and binary checksums: resources/runtimes.json. Corresponding upstream Git source and build recipes: https://github.com/desktop/dugite-native/tree/v2.53.0-4 (including its pinned git submodule and dependencies.json), https://github.com/git/git/tree/v2.53.0 and https://github.com/git-for-windows/git/tree/v2.56.0.windows.1. uv source: https://github.com/astral-sh/uv/tree/0.12.21. Kady launcher source and build recipes accompany this release in https://github.com/K-Dense-AI/k-dense-byok.\n");
console.log("Built", bundle);
