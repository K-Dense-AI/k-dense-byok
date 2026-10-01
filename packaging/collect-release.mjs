import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
const source = path.resolve("dist/installers"), destination = path.resolve("dist/release");
await fs.mkdir(destination, { recursive: true });
const expected = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];
const all = [];
for (const target of expected) {
  const dir = path.join(source, "installers-" + target);
  const sums = await fs.readFile(path.join(dir, "SHA256SUMS.txt"), "utf8");
  let count = 0;
  for (const line of sums.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (Kady-[A-Za-z0-9.-]+\.(?:dmg|exe|deb|rpm|tar\.gz))$/.exec(line);
    if (!match) throw new Error("Invalid installer checksum entry");
    const [, expectedHash, name] = match;
    if (all.some(item => item.endsWith("  " + name))) throw new Error("Duplicate release asset: " + name);
    const file = path.join(dir, name), hash = crypto.createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (hash.digest("hex") !== expectedHash) throw new Error("Installer checksum mismatch: " + name);
    await fs.copyFile(file, path.join(destination, name)); all.push(line); count++;
  }
  if (count !== (target === "linux-x64" ? 3 : 1)) throw new Error("Missing installer target: " + target);
}
await fs.writeFile(path.join(destination, "SHA256SUMS.txt"), all.sort().join("\n") + "\n");
console.log("Verified", all.length, "installers for release.");
