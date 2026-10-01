import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.ts";

// Import only configuration in each probe. Even a regression cannot execute a
// destructive test hook while this test verifies the fail-closed boundary.
function probe(file: string, env = process.env) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval",
    `await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, file)).href)})`,
  ], { env, encoding: "utf8", timeout: 10_000 });
}

it.each(["", path.join(REPO_ROOT, "projects")])("rejects tests with an unsafe projects root: %s", (projects) => {
  const result = probe("server/src/config.ts", { ...process.env, VITEST: "true", KADY_PROJECTS_ROOT: projects });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Tests require an explicit isolated KADY_PROJECTS_ROOT");
});

it("refuses the root Vitest configuration before discovery", () => {
  const result = probe("vitest.config.ts");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Do not run Vitest from the repository root");
});
