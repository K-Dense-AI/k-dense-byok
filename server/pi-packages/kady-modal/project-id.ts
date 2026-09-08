/**
 * Child-side project resolution for the kady-modal package.
 *
 * Vendored copy of `memoryProjectId` from kady-notebook/memory-client.ts. The
 * two packages are deliberately independent (no cross-package imports), so a
 * change to one must be mirrored by hand in the other.
 *
 * The pi-subagents runner hosts children with cwd inside the project sandbox,
 * but not necessarily *at* its root (a child may `cd` into a subdirectory), so
 * `basename(dirname(cwd))` is not a project id. Walk up to the nearest
 * directory literally named `sandbox`, read the sibling `project.json`, and
 * accept its id only when it is well-formed and matches the directory name.
 * An explicit `KADY_PROJECT_ID` must agree with what the sandbox says; with no
 * sandbox ancestor it is the only source. Never guess a project: a job that
 * lands in the wrong project would be billed to, and visible from, someone
 * else's workspace.
 */
import fs from "node:fs";
import path from "node:path";

const VALID_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function modalProjectId(
  cwd = process.cwd(),
  explicit = process.env.KADY_PROJECT_ID,
): string {
  let dir = path.resolve(cwd);
  let found: string | undefined;
  let sawSandbox = false;
  for (let depth = 0; depth < 32; depth++) {
    if (path.basename(dir) === "sandbox") {
      sawSandbox = true;
      const file = path.join(path.dirname(dir), "project.json");
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
          const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown };
          if (
            typeof meta.id === "string" &&
            VALID_PROJECT.test(meta.id) &&
            meta.id === path.basename(path.dirname(dir))
          ) {
            found = meta.id;
          }
        }
      } catch {
        /* no usable project metadata at this level */
      }
      if (found) break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (sawSandbox && !found) {
    throw new Error(
      "Sandbox project metadata is unavailable; refusing to guess the Modal project",
    );
  }
  if (explicit && (!VALID_PROJECT.test(explicit) || (found && found !== explicit))) {
    throw new Error("KADY_PROJECT_ID is invalid or conflicts with the sandbox project");
  }
  const id = found ?? explicit;
  if (!id) {
    throw new Error(
      "Cannot establish the child project for Modal compute; refusing to guess the project",
    );
  }
  return id;
}
