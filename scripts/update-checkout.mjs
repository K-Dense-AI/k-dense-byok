import { spawnSync } from "node:child_process";

export class CheckoutUpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckoutUpdateError";
  }
}

function git(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.error) {
    throw new CheckoutUpdateError(`Could not run git: ${result.error.message}`);
  }
  return result;
}

function gitText(repoRoot, args, failureMessage) {
  const result = git(repoRoot, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new CheckoutUpdateError(
      detail ? `${failureMessage}\n${detail}` : failureMessage,
    );
  }
  return result.stdout.trim();
}

/**
 * Safely fast-forward the current checkout from its configured upstream.
 *
 * We deliberately do not stash, reset, or merge. Automatic updating is only
 * safe when tracked files are clean and `git pull --ff-only` can advance the
 * current branch without rewriting local work.
 */
export function updateCheckout({ repoRoot, log = () => {} }) {
  const inside = gitText(
    repoRoot,
    ["rev-parse", "--is-inside-work-tree"],
    "This copy of Kady is not a Git checkout, so it cannot update itself.",
  );
  if (inside !== "true") {
    throw new CheckoutUpdateError(
      "This copy of Kady is not a Git checkout, so it cannot update itself.",
    );
  }

  const branch = gitText(
    repoRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "Automatic update is unavailable from a detached HEAD. Check out a branch first.",
  );

  const upstream = gitText(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    `Branch '${branch}' has no upstream branch. Configure one before using automatic update.`,
  );

  const dirty = gitText(
    repoRoot,
    ["status", "--porcelain", "--untracked-files=no"],
    "Could not inspect the Git working tree before updating.",
  );
  if (dirty) {
    throw new CheckoutUpdateError(
      "Kady has local changes in tracked files. Commit or discard them before updating; " +
        "the updater will never stash or overwrite your work automatically.",
    );
  }

  const before = gitText(repoRoot, ["rev-parse", "HEAD"], "Could not read the current revision.");
  log(`Updating ${branch} from ${upstream}...`);

  const pulled = git(repoRoot, ["pull", "--ff-only"]);
  const stdout = pulled.stdout.trim();
  const stderr = pulled.stderr.trim();
  if (stdout) log(stdout);
  if (pulled.status !== 0) {
    throw new CheckoutUpdateError(
      "Git could not fast-forward this checkout. No local history was rewritten." +
        (stderr ? `\n${stderr}` : ""),
    );
  }

  const after = gitText(repoRoot, ["rev-parse", "HEAD"], "Could not read the updated revision.");
  return { branch, upstream, before, after, updated: before !== after };
}
