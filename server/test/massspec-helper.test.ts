import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk = spawnSync(helperPython(), ["-c", "import pyteomics"], { stdio: "ignore" }).status === 0;
const mzmlPath = path.join(FIX, "sample.mzml");
const mzxmlPath = path.join(FIX, "sample.mzxml");

describe("massspec_helper", () => {
  it.runIf(depsOk)("summarizes an MGF peak list", () => {
    const res = runSciHelper("massspec", "summarize", [path.join(FIX, "sample.mgf")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mgf");
    expect(d.n_spectra).toBe(2);
    expect(d.spectra[0].mz.length).toBe(3);
    expect(d.spectra[0].intensity.length).toBe(3);
  }, 15000);

  it("summarizes a JCAMP-DX curve (no pyteomics needed)", () => {
    const res = runSciHelper("massspec", "summarize", [path.join(FIX, "sample.jdx")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("jcamp");
    expect(d.curve.x.length).toBe(4);
    expect(d.x_label.toLowerCase()).toContain("cm"); // XUNITS=1/CM
  }, 15000);

  it("exits 4 on a missing file", () => {
    expect(runSciHelper("massspec", "summarize", [path.join(FIX, "nope.mgf")]).status).toBe(4);
  });

  // "tiny.pwiz.1.1.mzML" from pyteomics' own test suite (~25KB, ProteoWizard tiny example).
  it.runIf(depsOk && fs.existsSync(mzmlPath))("summarizes an mzML run with an MS1 chromatogram", () => {
    const res = runSciHelper("massspec", "summarize", [mzmlPath]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mzml");
    expect(d.n_spectra).toBe(4);
    expect(d.chromatogram).not.toBeNull();
    expect(d.chromatogram.x.length).toBeGreaterThan(0);
  }, 15000);

  // "test.mzXML" from pyteomics' own test suite (~16KB).
  it.runIf(depsOk && fs.existsSync(mzxmlPath))("summarizes an mzXML run", () => {
    const res = runSciHelper("massspec", "summarize", [mzxmlPath]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mzxml");
    expect(d.n_spectra).toBe(2);
    expect(d.spectra.length).toBeGreaterThan(0);
  }, 15000);
});
