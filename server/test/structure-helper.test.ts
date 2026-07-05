import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk = spawnSync(helperPython(), ["-c", "import gemmi"], { stdio: "ignore" }).status === 0;

describe("structure_helper", () => {
  it.runIf(depsOk)("summarizes a small PDB", () => {
    const res = runSciHelper("structure", "summarize", [path.join(FIX, "mini.pdb")]);
    expect(res.status).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.num_atoms).toBeGreaterThan(0);
    expect(Array.isArray(data.chains)).toBe(true);
  }, 15000);

  it("exits 4 when the file does not exist", () => {
    const res = runSciHelper("structure", "summarize", [path.join(FIX, "does-not-exist.pdb")]);
    expect(res.status).toBe(4);
  });

  it("exits 1 for an unsupported render subcommand", () => {
    const res = runSciHelper("structure", "render", [path.join(FIX, "mini.pdb")]);
    expect(res.status).toBe(1);
  });
});
