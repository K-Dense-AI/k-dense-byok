import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

/** Upgrade only an exact historic shipped default. Edits, symlinks and deletions stick. */
export function upgradeSeededText(file: string, content: string, previousDigests: readonly string[]): boolean {
  let tmp: string | undefined;
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    const previous = fs.readFileSync(file, "utf8");
    const digest = createHash("sha256").update(previous.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
    if (!previousDigests.includes(digest)) return false;
    tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    // Do not knowingly overwrite an edit made while preparing the replacement.
    if (fs.readFileSync(file, "utf8") !== previous) return false;
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
