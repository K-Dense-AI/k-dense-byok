/**
 * First-run / refresh bootstrap — replaces prep_sandbox.py.
 *
 * Ensures the default project exists and seeds the scientific skills catalogue
 * into every non-archived project. Run via `npm run prep` (or from start.sh).
 */
import "./env.ts";
import { ensureProjectExists, listProjects, resolvePaths } from "./projects.ts";
import { seedProjectSkills } from "./agent/skills.ts";
import { seedSandboxFiles, syncSandboxVenv } from "./sandbox-seed.ts";
import { syncHelperVenv } from "./helpers-env.ts";
import { DEFAULT_PROJECT_ID } from "./config.ts";

async function main(): Promise<void> {
  ensureProjectExists(DEFAULT_PROJECT_ID);
  const projects = listProjects();
  for (const meta of projects) {
    if (meta.archived) continue;
    process.stdout.write(`== Initializing project: ${meta.id} (${meta.name}) ==\n`);
    const paths = resolvePaths(meta.id);
    seedSandboxFiles(paths);
    const count = seedProjectSkills(paths, true);
    process.stdout.write(`   skills: ${count}\n`);
    const synced = syncSandboxVenv(paths);
    process.stdout.write(`   venv: ${synced ? "synced" : "skipped (uv unavailable or sync failed)"}\n`);
  }
  const helperSynced = syncHelperVenv();
  process.stdout.write(`   helper venv: ${helperSynced ? "synced" : "skipped (uv unavailable or sync failed)"}\n`);
  process.stdout.write("Done.\n");
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
