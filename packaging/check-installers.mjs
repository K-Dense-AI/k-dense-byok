import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(repo, "dist", `${process.platform}-${process.arch}`);
const { version } = JSON.parse(await fs.readFile(path.join(base, "bundle/resources/distribution.json"), "utf8"));
const artifacts = path.join(base, "artifacts");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kady installer check "));
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}
const smoke = directory => run(process.execPath, [path.join(repo, "packaging/smoke.mjs"), directory], {
  env: { ...process.env, KADY_SMOKE_BROWSER: "1", KADY_SMOKE_HELPERS: "0" },
});
try {
  if (process.platform === "darwin") {
    const mount = path.join(temp, "mount"); await fs.mkdir(mount);
    await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, path.join(artifacts, `Kady-${version}-macos-${process.arch}.dmg`)]);
    try { await smoke(path.join(mount, "Kady.app")); }
    finally { await run("hdiutil", ["detach", mount]); }
  } else if (process.platform === "win32") {
    const installed = path.join(temp, "Kady installed ü");
    await run(path.join(artifacts, `Kady-${version}-windows-x64.exe`), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/DIR=" + installed]);
    try { await smoke(installed); }
    finally { await run(path.join(installed, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]); }
  } else {
    for (const format of ["deb", "rpm", "tar.gz"]) {
      const directory = path.join(temp, format); await fs.mkdir(directory);
      const file = path.join(artifacts, `Kady-${version}-linux-x64.${format}`);
      if (format === "deb") await run("dpkg-deb", ["--extract", file, directory]);
      else if (format === "tar.gz") await run("tar", ["-xzf", file, "-C", directory]);
      // libarchive handles RPM's absolute members and missing parent directory
      // entries while keeping extraction under the isolated destination.
      else await run("bsdtar", ["-xf", file, "-C", directory]);
      await smoke(format === "tar.gz" ? directory : path.join(directory, "opt/kady"));
      // Keep peak disk use bounded while testing three complete distributions.
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  console.log("Installer payload checks passed.");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
