/**
 * Table-driven checks for the raw-data guard classifier, run against BOTH the
 * server module and the byte-identical copy in the kady-guard package.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as server from "../src/agent/bash-classifier.ts";
import * as pkg from "../pi-packages/kady-guard/classifier.ts";

const SANDBOX = "/proj/sandbox";
const globs = ["user_data/**", "raw/*.csv", "reference"];

const protectedCases: Array<[string, string]> = [
  ["rm user_data/a.csv", "user_data/a.csv"],
  ["rm -rf user_data", "user_data"],
  ["rm -rf ./user_data/", "user_data"],
  ["rm -rf user_data/*", "user_data/*"],
  ["mv user_data/a.csv derived/", "user_data/a.csv"],
  ["cp derived/x.csv user_data/x.csv", "user_data/x.csv"],
  ["cd user_data && rm a.csv", "user_data/a.csv"],
  ["cd user_data; cd sub; rm b.csv", "user_data/sub/b.csv"],
  ["echo x > user_data/a.csv", "user_data/a.csv"],
  ["cat a >> user_data/log.txt", "user_data/log.txt"],
  ["sed -i 's/a/b/' user_data/a.csv", "user_data/a.csv"],
  ["perl -pi -e 's/a/b/' user_data/a.csv", "user_data/a.csv"],
  ["sudo rm -rf user_data", "user_data"],
  ["FOO=1 rm user_data/a.csv", "user_data/a.csv"],
  ["tee user_data/out.txt", "user_data/out.txt"],
  ["dd if=/dev/zero of=user_data/a.bin", "user_data/a.bin"],
  ["find user_data -name '*.tmp' -delete", "user_data"],
  ["rm raw/a.csv", "raw/a.csv"],
  ["rm reference/genome.fa", "reference/genome.fa"],
  [`rm -rf ${SANDBOX}/user_data/a.csv`, "user_data/a.csv"],
  ["touch user_data/.keep", "user_data/.keep"],
  ["chmod 600 user_data/a.csv", "user_data/a.csv"],
  ['rm "user_data/with space.csv"', "user_data/with space.csv"],
  ["git rm user_data/a.csv", "user_data/a.csv"],
  ["rsync -a derived/ user_data/", "user_data"],
];

const destructiveCases: string[] = [
  "rm -rf results",
  "rm -r derived",
  "rm -fr .",
  "rm *.csv",
  "git clean -fdx",
  "git reset --hard HEAD~1",
  "git checkout -- .",
  "find . -name '*.png' -delete",
  "ls | xargs rm",
  "shred secrets.txt",
  "dd if=a of=b",
  "rm -rf ../elsewhere",
];

const allowedCases: string[] = [
  "head user_data/a.csv",
  "cat user_data/a.csv | wc -l",
  "uv run python analyze.py --input user_data/a.csv --out derived/a.parquet",
  "cp user_data/a.csv derived/a.csv",
  "ls -la user_data",
  "grep -r foo user_data",
  "rm derived/tmp.txt",
  "rm -rf node_modules",
  "rm -rf .venv && uv sync",
  "rm -rf /tmp/scratch",
  "rm -rf __pycache__ .pytest_cache",
  "mv derived/a.csv derived/b.csv",
  "echo done > derived/log.txt",
  "git checkout -b feature",
  "cd user_data && head a.csv",
  "cd user_data && cd .. && rm derived/x",
  "find results -name '*.png'",
  "python -c \"print('rm -rf user_data')\"",
];

for (const [name, mod] of [
  ["server module", server],
  ["kady-guard package copy", pkg],
] as const) {
  describe(`classifyBashCommand (${name})`, () => {
    const opts = { protectedGlobs: globs, sandboxRoot: SANDBOX };
    it.each(protectedCases)("blocks protected mutation: %s", (command, expectedPath) => {
      const verdict = mod.classifyBashCommand(command, opts);
      expect(verdict.kind).toBe("protected");
      if (verdict.kind === "protected") expect(verdict.path).toBe(expectedPath);
    });
    it.each(destructiveCases)("flags destructive: %s", (command) => {
      expect(mod.classifyBashCommand(command, opts).kind).toBe("destructive");
    });
    it.each(allowedCases)("allows: %s", (command) => {
      expect(mod.classifyBashCommand(command, opts)).toEqual({ kind: "allow" });
    });
    it("classifies write/edit paths", () => {
      expect(mod.classifyFilePath("user_data/a.csv", opts)).toMatchObject({ kind: "protected", path: "user_data/a.csv" });
      expect(mod.classifyFilePath(`${SANDBOX}/user_data/deep/a.csv`, opts)).toMatchObject({ kind: "protected" });
      expect(mod.classifyFilePath("derived/a.csv", opts)).toEqual({ kind: "allow" });
      expect(mod.classifyFilePath("/etc/hosts", opts)).toEqual({ kind: "allow" });
      expect(mod.classifyFilePath("../escape/user_data/a.csv", opts)).toEqual({ kind: "allow" });
    });
    it("matches globs as documented", () => {
      expect(mod.globToRegExp("user_data/**").test("user_data")).toBe(true);
      expect(mod.globToRegExp("user_data/**").test("user_data/a/b.csv")).toBe(true);
      expect(mod.globToRegExp("user_data/**").test("user_data_backup/a")).toBe(false);
      expect(mod.globToRegExp("**/*.csv").test("a/b/c.csv")).toBe(true);
      expect(mod.globToRegExp("**/*.csv").test("c.csv")).toBe(true);
      expect(mod.globToRegExp("raw/*.csv").test("raw/a.csv")).toBe(true);
      expect(mod.globToRegExp("raw/*.csv").test("raw/sub/a.csv")).toBe(false);
      expect(mod.globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
      expect(mod.globToRegExp("a/**/b").test("a/b")).toBe(true);
      expect(mod.globToRegExp("reference").test("reference/genome.fa")).toBe(true);
      expect(mod.globToRegExp("data.??").test("data.gz")).toBe(true);
    });
  });
}

it("keeps the package copy byte-identical to the server module (after its header line)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", "bash-classifier.ts"), "utf-8");
  const copy = fs.readFileSync(path.join(import.meta.dirname, "..", "pi-packages", "kady-guard", "classifier.ts"), "utf-8");
  expect(copy.split("\n").slice(1).join("\n")).toBe(src);
});
