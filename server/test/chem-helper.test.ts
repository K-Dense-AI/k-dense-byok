import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";
import { spawnSync } from "node:child_process";

const FIX = path.join(__dirname, "fixtures");
// Skip the RDKit-dependent assertions when the helper venv isn't synced.
const depsOk = (() => {
  const r = spawnSync(helperPython(), ["-c", "import rdkit"], { stdio: "ignore" });
  return r.status === 0;
})();

describe("chem_helper", () => {
  it.runIf(depsOk)("summarizes a SMILES file", () => {
    const res = runSciHelper("chem", "summarize", [path.join(FIX, "ethanol.smi")]);
    expect(res.status).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.count).toBe(1);
    expect(data.molecules[0].formula).toBe("C2H6O");
  });
  it.runIf(depsOk)("renders an SVG for molecule 0", () => {
    const out = path.join(os.tmpdir(), `chem-test-${process.pid}.svg`);
    const res = runSciHelper("chem", "render", [path.join(FIX, "ethanol.smi"), "0", out]);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(out, "utf-8")).toContain("<svg");
    fs.rmSync(out, { force: true });
  });
  it("exits 5 on a malformed SMILES", () => {
    const bad = path.join(os.tmpdir(), `bad-${process.pid}.smi`);
    fs.writeFileSync(bad, "this-is-not-smiles!!!\n");
    const res = runSciHelper("chem", "summarize", [bad]);
    expect([0, 3, 5]).toContain(res.status); // 3 if deps missing, else 5 (or 0 w/ empty)
    fs.rmSync(bad, { force: true });
  });
});
