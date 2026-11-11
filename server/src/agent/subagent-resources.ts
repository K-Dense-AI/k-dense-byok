/** Seed the pinned plugin's prompts and complete skill trees once per project.
 * A marker makes deletions stick. Existing/disabled project resources win. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { atomicJson } from "../atomic-json.ts";

export function seedSubagentResources(paths: ProjectPaths): void {
  const marker = path.join(paths.kadyDir, "subagent-resources.json");
  if (fs.existsSync(marker)) return;
  const packageDir = path.dirname(createRequire(import.meta.url).resolve("pi-subagents"));
  for (const kind of ["prompts", "skills"] as const) {
    const source = path.join(packageDir, kind);
    const target = path.join(paths.sandbox, ".pi", kind);
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const dest = path.join(target, entry.name);
      if (fs.existsSync(dest) || (kind === "skills" && fs.existsSync(path.join(paths.sandbox, ".pi", "skills-disabled", entry.name)))) continue;
      fs.cpSync(path.join(source, entry.name), dest, { recursive: true, errorOnExist: true, force: false });
    }
  }
  atomicJson(marker, { version: 1 });
}
