import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// CI-only credential preparation. Only paths are exported; secrets never go
// into artifacts, command logs or workflow outputs.
async function run(command, args) { await new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
}); }
if (process.argv.includes("--cleanup")) {
  if (process.env.KADY_SIGNING_DIR) {
    if (process.platform === "darwin") await run("security", ["delete-keychain", path.join(process.env.KADY_SIGNING_DIR, "signing.keychain-db")]).catch(() => {});
    await fs.rm(process.env.KADY_SIGNING_DIR, { recursive: true, force: true });
  }
} else {
  if (!process.env.GITHUB_ENV) throw new Error("Signing setup runs only inside GitHub Actions.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kady-signing-"));
  await fs.appendFile(process.env.GITHUB_ENV, `KADY_SIGNING_DIR=${dir}\n`);
  const need = key => { const value = process.env[key]; if (!value) throw new Error(`Missing signing secret: ${key}`); return value; };
  if (process.platform === "darwin") {
    const cert = path.join(dir, "certificate.p12"), keychain = path.join(dir, "signing.keychain-db");
    const password = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(cert, Buffer.from(need("MACOS_CERTIFICATE_P12"), "base64"), { mode: 0o600 });
    await run("security", ["create-keychain", "-p", password, keychain]);
    await run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
    await run("security", ["unlock-keychain", "-p", password, keychain]);
    await run("security", ["import", cert, "-k", keychain, "-P", need("MACOS_CERTIFICATE_PASSWORD"), "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
    await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    await run("security", ["list-keychains", "-d", "user", "-s", keychain, path.join(os.homedir(), "Library/Keychains/login.keychain-db")]);
    const key = path.join(dir, "AuthKey.p8");
    await fs.writeFile(key, need("APPLE_API_KEY_P8"), { mode: 0o600 });
    await fs.appendFile(process.env.GITHUB_ENV, `APPLE_API_KEY_FILE=${key}\n`);
  } else if (process.platform === "win32") {
    const cert = path.join(dir, "certificate.pfx");
    await fs.writeFile(cert, Buffer.from(need("WINDOWS_CERTIFICATE_PFX"), "base64"));
    await fs.appendFile(process.env.GITHUB_ENV, `WINDOWS_CERTIFICATE_FILE=${cert}\n`);
  }
}
