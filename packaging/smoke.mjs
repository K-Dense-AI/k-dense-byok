import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBundle = path.resolve(process.argv[2] || path.join(repo, "dist", `${process.platform}-${process.arch}`, "bundle"));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kady installed smoke ü "));
const bundle = path.join(temp, "application ü");
await fs.cp(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const data = path.join(temp, "data");
const macApp = sourceBundle.endsWith(".app");
const binary = path.join(bundle, macApp ? "Contents/MacOS/kady" : process.platform === "win32" ? "kady.exe" : "kady");
// Model a system-owned installation. All mutable state must go to user storage.
async function writable(root, enable) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { if (enable) await fs.chmod(file, 0o700); await writable(file, enable); }
    if (!entry.isSymbolicLink() && !enable) await fs.chmod(file, (await fs.stat(file)).mode & ~0o222);
  }
}
if (process.platform !== "win32") await writable(bundle, false);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|CI)$/i.test(key)));
// A desktop launch has no developer shell's toolchain on PATH.
for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
env.PATH = process.platform === "win32"
  ? [env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32")].join(path.delimiter)
  : "/usr/bin:/bin:/usr/sbin:/sbin";
Object.assign(env, { KADY_DATA_DIR: data, KADY_CONFIG_DIR: path.join(temp, "config"), KADY_CACHE_DIR: path.join(temp, "cache"), PI_CODING_AGENT_DIR: path.join(temp, "pi"), KADY_SKILLS_AUTO_SYNC: "0", DEFAULT_MODEL_PROVIDER: "openai", DEFAULT_MODEL_ID: "gpt-4o-mini", OPENAI_API_KEY: "packaging-smoke-fixture" });
// Occupied requested ports exercise fallback without terminating their owner.
const occupied = http.createServer((_req, res) => res.end("untouched"));
await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
env.KADY_PORT = String(occupied.address().port); env.KADY_FRONTEND_PORT = env.KADY_PORT;
let pendingModelRequest = false;
const modelToolResults = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "packaging-smoke" }] })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelToolResults.push(...body.messages.filter(message => message.role === "tool"));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
  const hasResult = body.messages.some(m => m.role === "tool");
  const userText = body.messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content)).join(" ");
  if (userText.includes("PACKAGING_WAIT") && hasResult) { pendingModelRequest = true; res.flushHeaders(); return; }
  const childTask = userText.includes("PACKAGING_CHILD");
  const delegate = !childTask && userText.includes("PACKAGING_DELEGATE");
  const childShell = childTask && process.platform === "win32";
  const tool = userText.includes("PACKAGING_SHELL") ? { name: "bash", arguments: JSON.stringify({ command: "node --version > packaging-node.txt && npm --version > packaging-npm.txt && uv --version > packaging-uv.txt && git --version > packaging-git.txt && rg --version > packaging-rg.txt && fd --version > packaging-fd.txt" }) }
    : delegate ? { name: "subagent", arguments: JSON.stringify({ workflowScript: "return runs.run('smoke-child', { agent: 'worker', task: 'PACKAGING_CHILD: Write packaging-child.txt with the exact text Packaged runtime verified.' })" }) }
    : childShell ? { name: "bash", arguments: JSON.stringify({ command: "node --version && npm --version && uv --version && git --version && rg --version && fd --version && printf 'Packaged runtime verified.\\n' > packaging-child.txt" }) }
    : { name: "write", arguments: JSON.stringify({ path: childTask ? "packaging-child.txt" : "packaging-smoke.txt", content: "Packaged runtime verified.\n" }) };
  const delta = hasResult ? { content: "Packaged runtime verified." } : { tool_calls: [{ index: 0, id: "smoke_write", type: "function", function: tool }] };
  send({ id: "smoke", object: "chat.completion.chunk", model: "packaging-smoke", choices: [{ index: 0, delta, finish_reason: null }] });
  send({ id: "smoke", choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${model.address().port}`;
await fs.mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { openai: {
  baseUrl: env.OPENAI_COMPATIBLE_BASE_URL + "/v1", api: "openai-completions", apiKey: "packaging-smoke-fixture",
  models: [{ id: "gpt-4o-mini", name: "Packaging fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd: temp, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(output || `launcher exit ${code}`)));
  });
}
let state;
try {
  await run(["start", "--no-browser"]);
  state = JSON.parse(await fs.readFile(path.join(data, "instance.json"), "utf8"));
  const runtimeScript = await (await fetch(state.ui + "/runtime-config.js")).text();
  const api = JSON.parse(runtimeScript.match(/=(.*);/)[1]).apiBase;
  assert.notEqual(new URL(api).port, env.KADY_PORT);
  assert.equal(await (await fetch(`http://127.0.0.1:${env.KADY_PORT}`)).text(), "untouched");
  const request = (route, options = {}) => fetch(api + route, { ...options, headers: { "X-Kady-Token": state.token, Origin: state.ui, ...(options.headers || {}) } });
  assert.equal((await fetch(api + "/projects")).status, 401);
  assert.equal((await request("/projects", { headers: { Origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await request("/projects")).status, 200);
  assert.equal((await request("/installation").then(r => r.json())).packaged, true);
  const html = await (await fetch(state.ui)).text();
  assert.ok(html.includes("runtime-config.js"));
  const asset = html.match(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/);
  assert.ok(asset, "production static assets are referenced");
  assert.equal((await fetch(new URL(asset[1].replace(/&amp;/g, "&"), state.ui))).status, 200);
  await run(["start", "--no-browser"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(data, "instance.json"), "utf8")).pid, state.pid, "second launch reuses the supervisor");
  const sessionResponse = await request("/sessions", { method: "POST" });
  const session = await sessionResponse.json(); assert.equal(sessionResponse.status, 200, JSON.stringify(session));
  const runResponse = await request(`/sessions/${session.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Write packaging-smoke.txt to verify the installed runtime.", model: "openai/gpt-4o-mini" }), signal: AbortSignal.timeout(60_000) });
  const stream = await runResponse.text(); assert.equal(runResponse.status, 200, stream);
  assert.match(stream, /Packaged runtime verified/);
  assert.equal(await fs.readFile(path.join(data, "projects", "default", "sandbox", "packaging-smoke.txt"), "utf8"), "Packaged runtime verified.\n");
  const childSession = await request("/sessions", { method: "POST" }).then(r => r.json());
  const delegated = await request(`/sessions/${childSession.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "PACKAGING_DELEGATE: run the worker packaging check.", model: "openai/gpt-4o-mini" }), signal: AbortSignal.timeout(60_000) });
  const childStream = await delegated.text(); assert.equal(delegated.status, 200, childStream);
  await fs.writeFile(path.join(temp, "specialist-stream.txt"), childStream);
  const childFile = path.join(data, "projects", "default", "sandbox", "packaging-child.txt");
  for (let i = 0; i < 120; i++) { try { await fs.access(childFile); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  assert.equal(await fs.readFile(childFile, "utf8"), "Packaged runtime verified.\n", "detached specialist executes bundled extensions");
  const shellSession = await request("/sessions", { method: "POST" }).then(r => r.json());
  const shellRun = await request(`/sessions/${shellSession.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "PACKAGING_SHELL: check the private command-line runtimes.", model: "openai/gpt-4o-mini" }), signal: AbortSignal.timeout(60_000) });
  const shellStream = await shellRun.text(); assert.equal(shellRun.status, 200, shellStream);
  await fs.writeFile(path.join(temp, "shell-stream.txt"), shellStream);
  const shellEvents = shellStream.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.ok(shellEvents.some(event => event.type === "tool_end" && event.toolName === "bash" && !event.isError), shellStream);
  const sandbox = path.dirname(childFile);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-node.txt"), "utf8"), /^v24\.21\.0/);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-npm.txt"), "utf8"), /^\d+\.\d+/);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-uv.txt"), "utf8"), /^uv 0\.12\.21/);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-git.txt"), "utf8"), /^git version 2\./);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-rg.txt"), "utf8"), /^ripgrep 15\.2\.0/);
  assert.match(await fs.readFile(path.join(sandbox, "packaging-fd.txt"), "utf8"), /^fd 10\.3\.0/);
  if (process.env.KADY_SMOKE_BROWSER === "1") {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(state.ui + "/#kady-token=" + state.token);
      await page.waitForFunction(() => window.__KADY_RUNTIME__?.packaged === true);
      assert.equal(await page.evaluate(() => window.__KADY_RUNTIME__.apiBase), api);
      await page.waitForFunction(() => !window.location.hash.includes("kady-token"));
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("kady:open-settings", { detail: { tab: "services" } })));
      await page.getByText("Installed application", { exact: true }).waitFor();
      await page.getByRole("button", { name: "View logs", exact: true }).click();
      await page.locator("pre").filter({ hasText: "kady-server listening" }).waitFor();
      assert.deepEqual(errors, [], "packaged browser loaded without JavaScript errors");
      await page.screenshot({ path: path.join(temp, "installed-settings.png"), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: path.join(temp, "browser-failure.png"), fullPage: true });
      console.error("Browser failure:", errors, await page.evaluate(() => ({ pathname: location.pathname, tokenFragmentPresent: location.hash.includes("kady-token"), runtime: window.__KADY_RUNTIME__ })));
      throw error;
    } finally { await browser.close(); }
  }
  if (process.env.KADY_SMOKE_HELPERS === "1") {
    assert.equal((await request("/installation/helpers", { method: "POST" })).status, 202);
    const until = Date.now() + 10 * 60_000;
    let helpers;
    do {
      await new Promise(r => setTimeout(r, 1000));
      helpers = (await request("/installation").then(r => r.json())).helpers;
    } while (helpers.status === "installing" && Date.now() < until);
    assert.equal(helpers.status, "ready", helpers.detail);
    // A small NPY fixture exercises the actual installed Python decoder.
    const header = Buffer.from("{'descr': '<f8', 'fortran_order': False, 'shape': (2,), }".padEnd(117) + "\n");
    const npy = Buffer.alloc(10 + header.length + 16);
    Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]).copy(npy);
    npy.writeUInt16LE(header.length, 8); header.copy(npy, 10);
    npy.writeDoubleLE(2, 10 + header.length); npy.writeDoubleLE(4, 18 + header.length);
    await fs.writeFile(path.join(sandbox, "packaging-array.npy"), npy);
    const preview = await request("/sandbox/sci-summary?kind=arrays&path=packaging-array.npy");
    const summary = await preview.json(); assert.equal(preview.status, 200, JSON.stringify(summary));
    assert.equal(summary.plot.stats.mean, 3);
    console.log("Locked scientific preview environment installed and decoded an array successfully.");
  }
  const waitingSession = await request("/sessions", { method: "POST" }).then(r => r.json());
  const pending = await request(`/sessions/${waitingSession.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "PACKAGING_WAIT: wait for cancellation.", model: "openai/gpt-4o-mini" }), signal: AbortSignal.timeout(60_000) });
  const pendingStream = pending.text();
  for (let i = 0; i < 120 && !pendingModelRequest; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(pendingModelRequest, true, "model call is in flight before shutdown");
  await run(["stop"]);
  assert.match(await pendingStream, /"type":"done"/, "shutdown completes the in-flight run stream");
  for (let i = 0; i < 80; i++) { try { await fs.access(path.join(data, "instance.json")); await new Promise(r => setTimeout(r, 250)); } catch { break; } }
  await assert.rejects(fs.access(path.join(data, "instance.json")), "shutdown removes state");
  const costs = (await fs.readFile(path.join(sandbox, ".kady", "runs", waitingSession.id, "costs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(costs.some(row => row.sessionId === waitingSession.id), "shutdown persists the interrupted run ledger");
  await run(["start", "--no-browser"]);
  assert.equal(await fs.readFile(path.join(data, "projects", "default", "sandbox", "packaging-smoke.txt"), "utf8"), "Packaged runtime verified.\n");
  const restarted = JSON.parse(await fs.readFile(path.join(data, "instance.json"), "utf8"));
  const restartedConfig = await (await fetch(restarted.ui + "/runtime-config.js")).text();
  const restartedAPI = JSON.parse(restartedConfig.match(/=(.*);/)[1]).apiBase;
  process.kill(restarted.pid, "SIGKILL");
  let orphanExited = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(restartedAPI + "/health", { signal: AbortSignal.timeout(500) }); }
    catch { orphanExited = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(orphanExited, true, "services exit when their supervisor crashes");
  await run(["start", "--no-browser"]);
  assert.notEqual(JSON.parse(await fs.readFile(path.join(data, "instance.json"), "utf8")).pid, restarted.pid, "stale state is recoverable");
  console.log("Packaged smoke passed: production assets, dynamic ports, authentication, single instance, private shell tools, real Pi lead/child execution, graceful active-run shutdown, crash recovery and data retention.");
} catch (error) {
  console.error("Fixture model tool results:", JSON.stringify(modelToolResults));
  try { console.error((await fs.readFile(path.join(data, "logs", "kady.log"), "utf8")).slice(-18000)); } catch {}
  throw error;
} finally {
  try { await run(["stop"]); } catch {}
  for (let i = 0; i < 80; i++) { try { await fs.access(path.join(data, "instance.json")); await new Promise(r => setTimeout(r, 250)); } catch { break; } }
  occupied.closeAllConnections(); occupied.close(); model.closeAllConnections(); model.close();
  if (process.env.CI) {
    const diagnostics = path.join(repo, "dist", "diagnostics", String(Date.now()));
    await fs.mkdir(diagnostics, { recursive: true });
    for (const file of [path.join(data, "logs/kady.log"), path.join(temp, "installed-settings.png"), path.join(temp, "browser-failure.png"), path.join(temp, "specialist-stream.txt"), path.join(temp, "shell-stream.txt")]) {
      try { await fs.copyFile(file, path.join(diagnostics, path.basename(file))); } catch { /* Failure can precede file creation. */ }
    }
  }
  if (process.platform !== "win32") await writable(bundle, true);
  await fs.rm(bundle, { recursive: true, force: true });
  console.log("Smoke artifacts:", temp);
}
