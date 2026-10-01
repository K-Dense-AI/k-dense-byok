import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.platform}-${process.arch}`;
const base = path.join(repo, "dist", target);
const bundle = path.join(base, "bundle");
const distribution = JSON.parse(await fs.readFile(path.join(bundle, "resources", "distribution.json"), "utf8"));
const version = distribution.version;
const artifacts = path.join(base, "artifacts");
await fs.rm(artifacts, { recursive: true, force: true });
await fs.mkdir(artifacts, { recursive: true });
const requireSigning = process.argv.includes("--require-signing") || process.env.KADY_RELEASE === "1";
async function run(cmd, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code})`)));
  });
}
async function walk(root) {
  const files = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) files.push(...await walk(file)); else if (item.isFile()) files.push(file);
  }
  return files;
}
async function hash(file) { const hash = crypto.createHash("sha256"); for await (const b of createReadStream(file)) hash.update(b); return hash.digest("hex"); }

if (process.platform === "darwin") {
  const identity = process.env.MACOS_SIGN_IDENTITY;
  if (requireSigning && (!identity || !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER || !process.env.APPLE_API_KEY_FILE)) throw new Error("Release builds require macOS signing and notarization credentials.");
  const stage = path.join(base, "dmg"); await fs.rm(stage, { recursive: true, force: true });
  const app = path.join(stage, "Kady.app"), contents = path.join(app, "Contents");
  await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
  await fs.copyFile(path.join(bundle, "kady"), path.join(contents, "MacOS", "kady"));
  await fs.chmod(path.join(contents, "MacOS", "kady"), 0o755);
  await fs.cp(path.join(bundle, "resources"), path.join(contents, "Resources"), { recursive: true, verbatimSymlinks: true });
  for (const file of ["LICENSE", "README.txt", "THIRD-PARTY-NOTICES.txt"]) { try { await fs.copyFile(path.join(bundle, file), path.join(contents, "Resources", file)); } catch(e) { if(e.code !== "ENOENT") throw e; } }
  await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.k-dense.kady</string><key>CFBundleName</key><string>Kady</string><key>CFBundleDisplayName</key><string>Kady</string><key>CFBundleExecutable</key><string>kady</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/><key>CFBundleIconFile</key><string>Kady</string></dict></plist>`);
  const iconset = path.join(base, "Kady.iconset"); await fs.mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) await run("sips", ["-z", String(size * scale), String(size * scale), path.join(repo, "web/src/app/icon.png"), "--out", path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
  await run("iconutil", ["-c", "icns", iconset, "-o", path.join(contents, "Resources", "Kady.icns")]);
  if (identity) {
    // Sign nested executable code inside-out. Never patch the bundle afterward.
    for (const file of (await walk(contents)).sort((a, b) => b.length - a.length)) {
      const handle = await fs.open(file, "r"); const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); await handle.close();
      if (["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf"].includes(header.toString("hex"))) await run("codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", path.join(repo, "packaging/macos/entitlements.plist"), "--sign", identity, file]);
    }
    await run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, app]);
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    if (process.env.APPLE_API_KEY_FILE) {
      const zip = path.join(base, "notarize.zip"); await run("ditto", ["-c", "-k", "--keepParent", app, zip]);
      await run("xcrun", ["notarytool", "submit", zip, "--key", process.env.APPLE_API_KEY_FILE, "--key-id", process.env.APPLE_API_KEY_ID, "--issuer", process.env.APPLE_API_ISSUER, "--wait"]);
      await run("xcrun", ["stapler", "staple", app]); await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    }
  }
  await fs.symlink("/Applications", path.join(stage, "Applications"));
  const dmg = path.join(artifacts, `Kady-${version}-macos-${process.arch}.dmg`);
  await fs.rm(dmg, { force: true });
  await run("hdiutil", ["create", "-volname", "Kady", "-srcfolder", stage, "-ov", "-format", "UDZO", dmg]);
  if (identity) await run("codesign", ["--sign", identity, "--timestamp", dmg]);
} else if (process.platform === "win32") {
  const cert = process.env.WINDOWS_CERTIFICATE_FILE;
  if (requireSigning && (!cert || !process.env.WINDOWS_CERTIFICATE_PASSWORD)) throw new Error("Release builds require Windows signing credentials.");
  let signtool = process.env.SIGNTOOL;
  if (cert && !signtool) {
    const kits = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
    const choices = (await walk(kits)).filter(p => /[\\/]x64[\\/]signtool\.exe$/i.test(p)).sort(); signtool = choices.at(-1);
  }
  const sign = async file => {
    if (!cert) return;
    if (!signtool) throw new Error("Windows SDK signtool was not found.");
    await run(signtool, ["sign", "/f", cert, "/p", process.env.WINDOWS_CERTIFICATE_PASSWORD, "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", file]);
    await run(signtool, ["verify", "/pa", file]);
  };
  for (const launcher of ["kady.exe", "kadyw.exe"]) await sign(path.join(bundle, launcher));
  const iscc = process.env.ISCC || path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe");
  await run(iscc, [`/DAppVersion=${version}`, `/DBundleDir=${bundle}`, `/DOutputDir=${artifacts}`, path.join(repo, "packaging/windows/kady.iss")]);
  await sign(path.join(artifacts, `Kady-${version}-windows-x64.exe`));
} else if (process.platform === "linux") {
  const config = path.join(base, "nfpm.json");
  await fs.writeFile(config, JSON.stringify({ name: "kady", arch: "amd64", platform: "linux", version, maintainer: "K-Dense <support@k-dense.ai>", description: "K-Dense BYOK local research assistant", homepage: "https://github.com/K-Dense-AI/k-dense-byok", license: "MIT", section: "science", depends: ["libc6 (>= 2.28)", "libstdc++6", "bash", "xdg-utils", "ca-certificates"], contents: [{ src: bundle + "/", dst: "/opt/kady", type: "tree" }, { src: "/opt/kady/kady", dst: "/usr/bin/kady", type: "symlink" }, { src: path.join(repo, "packaging/linux/kady.desktop"), dst: "/usr/share/applications/kady.desktop" }, { src: path.join(repo, "web/src/app/icon.png"), dst: "/usr/share/icons/hicolor/512x512/apps/kady.png" }], overrides: { rpm: { depends: ["glibc >= 2.28", "libstdc++", "bash", "xdg-utils", "ca-certificates"] } } }, null, 2));
  for (const format of ["deb", "rpm"]) await run(process.env.NFPM || "nfpm", ["package", "--config", config, "--packager", format, "--target", path.join(artifacts, `Kady-${version}-linux-x64.${format}`)]);
  await run("tar", ["-czf", path.join(artifacts, `Kady-${version}-linux-x64.tar.gz`), "-C", bundle, "."]);
} else throw new Error("Unsupported installer platform");

const files = (await fs.readdir(artifacts)).filter(n => n !== "SHA256SUMS.txt");
await fs.writeFile(path.join(artifacts, "SHA256SUMS.txt"), (await Promise.all(files.map(async name => `${await hash(path.join(artifacts, name))}  ${name}`))).join("\n") + "\n");
console.log("Installers:", artifacts, requireSigning ? "(release signing required)" : "(development build; signing optional)");
