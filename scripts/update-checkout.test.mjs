import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateCheckout } from "./update-checkout.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-update-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");

  git(root, ["init", "--bare", "-b", "main", remote]);
  fs.mkdirSync(seed);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Kady test"]);
  git(seed, ["config", "user.email", "kady-test@example.invalid"]);
  fs.writeFileSync(path.join(seed, "version.txt"), "one\n");
  git(seed, ["add", "version.txt"]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["clone", remote, checkout]);

  return {
    root,
    seed,
    checkout,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function publishNext(seed, value = "two\n") {
  fs.writeFileSync(path.join(seed, "version.txt"), value);
  git(seed, ["add", "version.txt"]);
  git(seed, ["commit", "-m", "next"]);
  git(seed, ["push"]);
}

test("fast-forwards a clean checkout from its configured upstream", () => {
  const f = fixture();
  try {
    publishNext(f.seed);
    const messages = [];
    const result = updateCheckout({ repoRoot: f.checkout, log: (line) => messages.push(line) });

    assert.equal(result.updated, true);
    assert.equal(result.branch, "main");
    assert.equal(result.upstream, "origin/main");
    assert.equal(fs.readFileSync(path.join(f.checkout, "version.txt"), "utf-8"), "two\n");
    assert.ok(messages.some((line) => line.includes("Updating main from origin/main")));
  } finally {
    f.cleanup();
  }
});

test("does not touch tracked local changes", () => {
  const f = fixture();
  try {
    publishNext(f.seed);
    fs.writeFileSync(path.join(f.checkout, "version.txt"), "my local edit\n");

    assert.throws(
      () => updateCheckout({ repoRoot: f.checkout }),
      /local changes in tracked files/,
    );
    assert.equal(fs.readFileSync(path.join(f.checkout, "version.txt"), "utf-8"), "my local edit\n");
  } finally {
    f.cleanup();
  }
});

test("refuses branches without a configured upstream", () => {
  const f = fixture();
  try {
    git(f.checkout, ["checkout", "-b", "local-only"]);
    assert.throws(
      () => updateCheckout({ repoRoot: f.checkout }),
      /has no upstream branch/,
    );
  } finally {
    f.cleanup();
  }
});
