#!/usr/bin/env node
/**
 * Kady launcher — cross-platform port of the original start.sh, used on
 * macOS, Linux, and Windows alike. Zero dependencies (it runs before any
 * npm install). The platform wrappers (start.sh / start.cmd) only make sure
 * Node itself exists, then exec this file.
 *
 * Flags:
 *   --check       report dependencies/environment and exit (no installs, no services)
 *   --no-browser  don't open the UI in a browser once it's up
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "./env-file.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const flags = {
  check: process.argv.includes("--check"),
  noBrowser: process.argv.includes("--no-browser"),
};

// Legacy conhost garbles unicode; Windows Terminal (WT_SESSION) renders it fine.
const sym =
  isWin && !process.env.WT_SESSION
    ? { ok: "OK", warn: "!", err: "X", arrow: "->" }
    : { ok: "✓", warn: "⚠", err: "✗", arrow: "→" };

const log = (msg = "") => console.log(msg);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion, streaming output. Returns the exit code. */
function run(cmd, args, opts = {}) {
  // npm on Windows is npm.cmd; Node >= 22 requires shell:true to spawn .cmd
  // files (CVE-2024-27980). Args here are always our own literals, never
  // user input, so shell interpolation is not a concern.
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  return res.status ?? 1;
}

/** Run a command silently; return trimmed stdout, or null on any failure. */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf-8", shell: isWin });
  return res.status === 0 ? res.stdout.trim() : null;
}

const has = (cmd) => capture(cmd, ["--version"]) !== null;

// ---- Step 1: dependency checks -------------------------------------------

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    const hint = isWin
      ? "    Upgrade with 'winget install OpenJS.NodeJS.LTS' or from https://nodejs.org/,"
      : process.platform === "darwin"
        ? "    Upgrade with 'brew install node' or from https://nodejs.org/,"
        : "    Upgrade via https://nodejs.org/ or your version manager (e.g. 'nvm install 22'),";
    fail(
      `  ${sym.err} Node.js v${process.versions.node} is too old — Kady needs Node.js >= 22 to\n` +
        `    build and install its packages.\n${hint}\n    then start Kady again.`,
    );
  }
  log(`  Node.js ${sym.ok} (v${process.versions.node})`);
  if (major === 22 && minor < 19) {
    log(`  ${sym.warn} Pi recommends Node >= 22.19; you have v${process.versions.node}. It usually still works.`);
  }
}

const localBin = path.join(os.homedir(), ".local", "bin");

function uvInstalled() {
  return (
    has("uv") ||
    fs.existsSync(path.join(localBin, "uv")) ||
    fs.existsSync(path.join(localBin, "uv.exe"))
  );
}

// uv — the agent runs all sandbox Python through uv (`uv run`, `uv add`).
// Without it, every Python task the agent attempts will fail.
function ensureUv() {
  if (uvInstalled()) {
    log(`  uv ${sym.ok}`);
  } else if (flags.check) {
    log(`  ${sym.warn} uv not found — it will be installed on the next full start.`);
  } else {
    log("  uv not found — installing...");
    if (isWin) {
      // shell:false is required here: under shell:true cmd.exe would parse the
      // unquoted `|` as a cmd pipeline instead of passing it to PowerShell.
      run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"], { shell: false });
    } else if (has("brew")) {
      run("brew", ["install", "uv"]);
    } else {
      run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
    }
    if (!uvInstalled()) {
      log(`  ${sym.warn} uv install did not complete — the agent's Python tasks will fail until uv is installed (https://docs.astral.sh/uv/).`);
    }
  }
  // The official installer puts uv in ~/.local/bin (all platforms); make it
  // visible to the backend and the sandbox sessions spawned below.
  process.env.PATH = localBin + path.delimiter + (process.env.PATH ?? "");
}

function checkGit() {
  if (has("git")) {
    log(`  git ${sym.ok}`);
  } else if (isWin) {
    // The Pi agent runs its shell commands through the bash that Git for
    // Windows provides, so on Windows git is a hard requirement.
    fail(
      `  ${sym.err} Git for Windows is required — Kady's agent runs its shell commands\n` +
        "    through the Git Bash it provides. Install it from\n" +
        "    https://git-scm.com/download/win (the default components are fine),\n" +
        "    reopen your terminal, then run start.cmd again.",
    );
  } else {
    log(`  ${sym.warn} git not found — the skills catalogue download will be skipped.`);
    log("    Install git (e.g. 'xcode-select --install' on macOS) to get skills.");
  }
}

function checkPython() {
  // Only used for scientific file-preview helpers; everything else goes
  // through uv. No `python3` alias exists on Windows, and uv covers it there.
  if (isWin) return;
  if (has("python3")) log(`  python3 ${sym.ok}`);
  else log(`  ${sym.warn} python3 not found — some scientific file previews won't work.`);
}

// ---- Step 2: environment ---------------------------------------------------

function setupEnv() {
  const rootEnv = path.join(repoRoot, ".env");
  const legacyEnv = path.join(repoRoot, "kady_agent", ".env");
  const example = path.join(repoRoot, ".env.example");
  if (!fs.existsSync(rootEnv) && !fs.existsSync(legacyEnv) && fs.existsSync(example)) {
    if (flags.check) {
      log("No .env found — a full start will create one from .env.example.");
    } else {
      log("No .env found — creating one from .env.example.");
      fs.copyFileSync(example, rootEnv);
      log(`  ${sym.arrow} Edit .env and set OPENROUTER_API_KEY (or run a local Ollama).`);
    }
  }
  // The backend re-loads these itself (server/src/env.ts); loading them here
  // covers the frontend (NEXT_PUBLIC_* vars) and the launcher's own checks.
  // override:true = .env beats stale ambient shell exports, matching the old
  // `set -a; source .env` behavior for both spawned services.
  if (applyEnvFile(rootEnv, { override: true })) log("Loading environment from .env...");
  else if (applyEnvFile(legacyEnv, { override: true })) log("Loading environment from kady_agent/.env...");
}

/** The agent needs OpenRouter or a reachable Ollama to do anything. */
async function checkModelAccess() {
  if (process.env.OPENROUTER_API_KEY) return;
  const ollama = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  try {
    await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(2000) });
    log(`  No OPENROUTER_API_KEY set — using local Ollama at ${ollama}.`);
  } catch {
    log("");
    log(`  ${sym.warn} No OPENROUTER_API_KEY in .env and no Ollama at ${ollama}.`);
    log("    The UI will start, but the agent cannot run until you either:");
    log("      - add OPENROUTER_API_KEY to .env (https://openrouter.ai/keys), or");
    log("      - start a local Ollama (https://ollama.com) with a pulled model.");
    log("");
  }
}

// ---- Step 3: npm install ----------------------------------------------------

function installPackages(dir, label) {
  log(`Installing ${label} packages...`);
  const code = run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: path.join(repoRoot, dir),
  });
  if (code !== 0) {
    fail(
      `\n  ${sym.err} Installing the ${label} packages failed (see the error above).\n` +
        "    The most common cause is a network problem — check your internet\n" +
        "    connection and start Kady again. If it keeps failing, run\n" +
        `    'npm install' inside ${dir}/ to see the full error, or report it at\n` +
        "    https://github.com/K-Dense-AI/k-dense-byok/issues",
    );
  }
}

// ---- Step 4: free the ports --------------------------------------------------

/** PIDs listening on `port` (deduped). A bind-probe is NOT a substitute:
 *  binding 127.0.0.1 succeeds even while another process holds the IPv6
 *  wildcard (how `next dev` listens), so only lsof/netstat sees the truth. */
function listenersOn(port) {
  if (isWin) {
    // No -p filter: TCPv4 and TCPv6 are separate protocols to netstat, and
    // Node listens on the v6 wildcard by default. The state column is
    // LOCALIZED on non-English Windows, so match on proto + local address
    // + a numeric PID instead; TIME_WAIT rows report PID 0 and are skipped.
    const out = capture("netstat", ["-ano"]) ?? "";
    const pids = new Set();
    for (const line of out.split("\n")) {
      const cols = line.trim().split(/\s+/);
      // Proto Local Foreign [State] PID
      if (cols.length < 4 || !cols[0].toUpperCase().startsWith("TCP")) continue;
      if (!cols[1].endsWith(`:${port}`)) continue;
      const pid = cols[cols.length - 1];
      if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    return [...pids];
  }
  const out = capture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]) ?? "";
  return [...new Set(out.split("\n").filter(Boolean))];
}

/** Was this PID started from inside this repo (i.e. a leftover Kady process)? */
function ownedByThisRepo(pid) {
  if (isWin) {
    // No process cwd on Windows; our services' command lines embed repo paths
    // (…\server\node_modules\…, …\web\node_modules\…), so match on those.
    const out = capture("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
    ]);
    if (!out) return false;
    return out.replaceAll("\\", "/").toLowerCase().includes(repoRoot.replaceAll("\\", "/").toLowerCase());
  }
  const out = capture("sh", ["-c", `lsof -a -p ${Number(pid)} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'`]);
  return !!out && out.split("\n")[0].startsWith(repoRoot);
}

function processName(pid) {
  if (isWin) {
    const out = capture("tasklist", ["/fi", `PID eq ${Number(pid)}`, "/fo", "csv", "/nh"]) ?? "";
    return out.split(",")[0]?.replaceAll('"', "") || "another program";
  }
  return capture("ps", ["-o", "comm=", "-p", String(pid)]) || "another program";
}

async function killTree(pid) {
  if (isWin) {
    capture("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    try {
      process.kill(Number(pid), 0);
    } catch {
      return; // gone
    }
  }
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * A previous run that didn't shut down cleanly can leave processes holding
 * the ports. Leftovers from this project are stopped automatically; anything
 * else gets a clear message naming the program in the way.
 */
async function freePort(port, label) {
  for (const pid of listenersOn(port)) {
    if (ownedByThisRepo(pid)) {
      log(`  Stopping a leftover Kady process on port ${port} (PID ${pid})...`);
      await killTree(pid);
    } else {
      fail(
        `\n  ${sym.err} Port ${port} is already in use by: ${processName(pid)} (PID ${pid}).\n` +
          `    The ${label} needs this port. Quit that program, then start Kady\n` +
          "    again. (Restarting your computer also clears it.)",
      );
    }
  }
}

// ---- Step 5/6: services + lifecycle -----------------------------------------

const children = [];
let shuttingDown = false;

/** True once the child has terminated — by exit code OR by signal (a
 *  signal-killed child keeps exitCode === null and sets signalCode). */
const gone = (child) => child.exitCode !== null || child.signalCode !== null;

function startService(label, dir, npmArgs) {
  log(`  ${sym.arrow} ${label}`);
  const cwd = path.join(repoRoot, dir);
  const child = isWin
    ? // One command string through cmd.exe: required for npm.cmd (see run()),
      // and taskkill /T reaps the whole tree on shutdown.
      spawn(["npm", ...npmArgs].join(" "), { cwd, stdio: "inherit", shell: true })
    : // Own process group so Ctrl+C in the terminal reaches only the
      // launcher, which then tears the groups down in order.
      spawn("npm", npmArgs, { cwd, stdio: "inherit", detached: true });
  children.push(child);
  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", () => {
    if (!shuttingDown) {
      console.error(`\n  ${sym.err} The ${label} stopped unexpectedly.`);
      console.error("    Scroll up for its error message, then start Kady again.");
      console.error("    If you're stuck, report the error at");
      console.error("    https://github.com/K-Dense-AI/k-dense-byok/issues");
      stopAll(1);
    }
  });
  return child;
}

async function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("\nShutting down...");
  if (isWin) {
    for (const child of children) {
      if (!gone(child)) capture("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    }
    process.exit(code);
  }
  for (const child of children) {
    if (gone(child)) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  // Grace period, then make sure nothing survives holding the ports.
  const allExited = Promise.all(
    children.map((c) => (gone(c) ? null : new Promise((r) => c.once("exit", r)))),
  );
  await Promise.race([allExited, sleep(3000)]);
  for (const child of children) {
    if (gone(child)) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

/** Wait until the service answers HTTP (any response counts). Child death is
 *  handled by the 'exit' watcher in startService, which tears everything down. */
async function waitFor(url, label, timeoutSec) {
  for (let i = 0; i < timeoutSec && !shuttingDown; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return; // any HTTP response = up and listening
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (!shuttingDown) {
    log(`  ${sym.warn} The ${label} is taking longer than expected — it may still be starting.`);
  }
}

function openBrowser(url) {
  if (flags.noBrowser) return;
  try {
    if (isWin) spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore" });
    else spawn("xdg-open", [url], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

// ---- main --------------------------------------------------------------------

log("============================================");
log("  Kady — Starting up");
log("============================================");
log("");
log("Checking dependencies...");

checkNode();
ensureUv();
checkGit();
checkPython();
// Pi itself needs no separate install: it's an npm dependency of server/
// (@earendil-works/pi-coding-agent), installed/updated by npm install below.
log(`  Pi agent ${sym.ok} (bundled with backend packages — no global install needed)`);
log("");

setupEnv();
await checkModelAccess();

if (flags.check) {
  log("");
  log(`${sym.ok} Dependency check complete (no services started).`);
  process.exit(0);
}

installPackages("server", "backend");
installPackages("web", "frontend");
log("");

const BACKEND_PORT = Number(process.env.KADY_PORT || 8000);
const FRONTEND_PORT = Number(process.env.KADY_FRONTEND_PORT || 3000);

await freePort(BACKEND_PORT, "backend");
await freePort(FRONTEND_PORT, "app UI");

log("Preparing projects (ensures default project, downloads scientific skills from K-Dense)...");
if (run("npm", ["run", "prep", "--silent"], { cwd: path.join(repoRoot, "server") }) !== 0) {
  log("  (skills download skipped/failed — continuing)");
}
log("");

log("Starting services...");
log("");
startService(`Backend on port ${BACKEND_PORT} (Pi agent, TypeScript)`, "server", ["run", "start"]);
startService(`Frontend on port ${FRONTEND_PORT} (Next.js UI)`, "web", [
  "run", "dev", "--", "-p", String(FRONTEND_PORT),
]);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
// Terminal window closed / SSH session dropped: without this the launcher
// dies on SIGHUP while the detached children survive as orphans.
process.on("SIGHUP", () => stopAll(0));

log("");
log("Waiting for services to come up (the first run can take a minute)...");
await waitFor(`http://localhost:${BACKEND_PORT}/`, "backend", 120);
await waitFor(`http://localhost:${FRONTEND_PORT}/`, "app UI", 180);

if (!shuttingDown) {
  log("");
  log("============================================");
  log("  All services running!");
  log(`  UI: http://localhost:${FRONTEND_PORT}`);
  log("  Press Ctrl+C to stop everything");
  log("============================================");
  openBrowser(`http://localhost:${FRONTEND_PORT}`);
}
// The children hold the event loop open; nothing more to await.
