import fs from "node:fs";
import path from "node:path";

/**
 * Write JSON durably: temp file in the same directory, fsync the data, then a
 * same-directory rename so readers never observe a partial document and a
 * power loss cannot surface an empty file under the final name.
 */
export function atomicJson(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
