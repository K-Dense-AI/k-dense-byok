import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { distillHelperError, runHelperScript, runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const depsOk = spawnSync(helperPython(), ["-c", "import pyteomics"], { stdio: "ignore" }).status === 0;

describe("distillHelperError", () => {
  it("drops import-time warnings that precede the real error", () => {
    const stderr = [
      "/venv/lib/python3.13/site-packages/psims/mzmlb/writer.py:33: UserWarning: hdf5plugin is missing! Only the slower GZIP compression scheme will be available!",
      "  warnings.warn(",
      "XMLSyntaxError: Premature end of data in tag mzML line 1, line 1, column 16",
    ].join("\n");
    expect(distillHelperError(stderr)).toBe(
      "XMLSyntaxError: Premature end of data in tag mzML line 1, line 1, column 16",
    );
  });

  it("falls back to the warnings when they are all there is", () => {
    const stderr = "/x.py:1: FutureWarning: soon\n  warnings.warn(\n";
    expect(distillHelperError(stderr)).toBe(
      "/x.py:1: FutureWarning: soon\n  warnings.warn(",
    );
  });

  it("strips RDKit log timestamps and its caret art", () => {
    const stderr = [
      "[13:07:22] SMILES Parse Error: check for mistakes around position 3:",
      "[13:07:22] not-a-smiles-@@@@",
      "[13:07:22] ~~^",
      "[13:07:22] SMILES Parse Error: Failed parsing SMILES 'not-a-smiles-@@@@'",
      "No valid molecules parsed",
    ].join("\n");
    expect(distillHelperError(stderr)).toBe(
      [
        "not-a-smiles-@@@@",
        "SMILES Parse Error: Failed parsing SMILES 'not-a-smiles-@@@@'",
        "No valid molecules parsed",
      ].join("\n"),
    );
  });

  it("keeps a plain single-line message", () => {
    expect(distillHelperError("pyteomics not installed: no module\n")).toBe(
      "pyteomics not installed: no module",
    );
  });

  it("returns nothing for silent failures", () => {
    expect(distillHelperError("")).toBe("");
  });
});

describe("helper failures reach the caller as a usable message", () => {
  it.runIf(depsOk)("cancels an abandoned subprocess without reporting a timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-helper-abort-"));
    const script = path.join(dir, "slow.py");
    fs.writeFileSync(script, "import time\ntime.sleep(60)\n");
    const controller = new AbortController();
    const pending = runHelperScript(script, [], 5000, controller.signal);
    const expectation = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    try { await expectation; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.runIf(depsOk)("reports the parse error for a corrupt mzML", async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kady-sci-")),
      "broken.mzml",
    );
    fs.writeFileSync(file, "<mzML>truncated");
    const res = await runSciHelper("massspec", "summarize", [file]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/XMLSyntaxError|Premature end of data/);
    expect(res.stderr).not.toMatch(/hdf5plugin/);
  }, 30_000);
});
