import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runtimePaths } from "./runtime-paths.ts";
import { HELPERS_DIR, helperEnvironmentDir, helperPython } from "./helpers-env.ts";
import { findUv } from "./binaries.ts";

type ComponentState = { status: "missing" | "installing" | "ready" | "error"; detail: string };
let helperState: ComponentState | null = null;

export function helperStatus(): ComponentState {
  if (helperState?.status === "installing" || helperState?.status === "error") return helperState;
  const ready = fs.existsSync(path.join(helperEnvironmentDir(), ".kady-ready")) && fs.existsSync(helperPython());
  return { status: ready ? "ready" : "missing", detail: ready ? "Scientific previews are ready." : "Install the Python tools for scientific file previews." };
}

/** A partial install never counts as ready. Retrying uses uv's locked cache. */
export function installHelpers(): ComponentState {
  if (helperState?.status === "installing") return helperState;
  const uv = findUv();
  if (!uv) throw new Error("The bundled Python installer is missing. Reinstall Kady.");
  const environment = helperEnvironmentDir();
  fs.mkdirSync(environment, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(environment, ".kady-ready"), { force: true });
  helperState = { status: "installing", detail: "Downloading Python and scientific preview tools…" };
  const child = spawn(uv, ["sync", "--frozen", "--project", HELPERS_DIR, "--python", "3.12.14", "--python-preference", "only-managed"], {
    cwd: runtimePaths().data, windowsHide: true,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const progress = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8192);
    const line = output.trim().split(/\r?\n/).at(-1);
    if (line && helperState?.status === "installing") helperState.detail = line.slice(0, 300);
  };
  child.stdout.on("data", progress);
  child.stderr.on("data", progress);
  const timeout = setTimeout(() => child.kill(), 20 * 60 * 1000);
  timeout.unref();
  child.on("error", (error) => { clearTimeout(timeout); helperState = { status: "error", detail: error.message }; });
  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      try {
        fs.writeFileSync(path.join(environment, ".kady-ready"), new Date().toISOString(), { mode: 0o600 });
        helperState = { status: "ready", detail: "Scientific previews are ready." };
      } catch (error) { helperState = { status: "error", detail: String(error) }; }
    } else helperState = { status: "error", detail: "Setup did not finish. Check your connection and retry. " + output.trim().slice(-600) };
  });
  return helperState;
}
