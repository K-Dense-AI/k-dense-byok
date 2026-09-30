import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk = spawnSync(helperPython(), ["-c", "import pyteomics"], { stdio: "ignore" }).status === 0;
const mzmlPath = path.join(FIX, "sample.mzml");
const mzxmlPath = path.join(FIX, "sample.mzxml");

async function jcampPreview(records: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-jcamp-test-"));
  try {
    const file = path.join(dir, "spectrum.jdx");
    fs.writeFileSync(file, `##TITLE=Numeric test spectrum\n##JCAMP-DX=4.24\n##DATA TYPE=INFRARED SPECTRUM\n##ORIGIN=Kady tests\n##OWNER=Public domain\n##XUNITS=1/CM\n##YUNITS=ABSORBANCE\n${records}\n##END=\n`);
    return await runSciHelper("massspec", "summarize", [file]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe("massspec_helper", () => {
  it.runIf(depsOk)("summarizes an MGF peak list", async () => {
    const res = await runSciHelper("massspec", "summarize", [path.join(FIX, "sample.mgf")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mgf");
    expect(d.n_spectra).toBe(2);
    expect(d.spectra[0].mz.length).toBe(3);
    expect(d.spectra[0].intensity.length).toBe(3);
  }, 15000);

  it("summarizes a JCAMP-DX curve (no pyteomics needed)", async () => {
    const res = await runSciHelper("massspec", "summarize", [path.join(FIX, "sample.jdx")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("jcamp");
    expect(d.curve.x.length).toBe(4);
    expect(d.x_label.toLowerCase()).toContain("cm"); // XUNITS=1/CM
  }, 15000);

  // JCAMP-DX 4.24 sections 5.1.1, 6.2.5, 6.4.1.3: actual interval
  // (LASTX-FIRSTX)/(NPOINTS-1), scaled values, and either abscissa order.
  // https://iupac.org/wp-content/uploads/2021/08/JCAMP-DX_IR_1988.pdf
  it("preserves descending JCAMP positions and scaled intensities across rows", async () => {
    const response = await jcampPreview("##XFACTOR=0.1\n##YFACTOR=0.01\n##FIRSTX=4000\n##LASTX=3998\n##NPOINTS=5\n##FIRSTY=1\n##DELTAX=-0.49\n##XYDATA=(X++(Y..Y))\n40000 100 200 300 $$ comment\n39985 400 500");
    expect(response.status, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout).curve).toEqual({ x: [4000, 3999.5, 3999, 3998.5, 3998], y: [1, 2, 3, 4, 5] });
  });

  it("reconstructs ascending non-unit intervals", async () => {
    const response = await jcampPreview("##FIRSTX=10\n##LASTX=11\n##NPOINTS=3\n##XYDATA=(X++(Y..Y))\n10 3 5 7");
    expect(response.status, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout).curve).toEqual({ x: [10, 10.5, 11], y: [3, 5, 7] });
  });

  it.each([
    ["decimal", "0.7", 1, 1],
    ["scientific notation", "7E-1", 1, 1],
    ["scaled integer", "1", 0.1, 0.2],
  ])("accepts rounded %s checkpoints while reconstructing the full-precision interval", async (_name, checkpoint, factor, last) => {
    const response = await jcampPreview(`##XFACTOR=${factor}\n##FIRSTX=0\n##LASTX=${last}\n##NPOINTS=4\n##XYDATA=(X++(Y..Y))\n0 10 20\n${checkpoint} 30 40`);
    expect(response.status, response.stderr).toBe(0);
    const curve = JSON.parse(response.stdout).curve;
    expect(curve.y).toEqual([10, 20, 30, 40]);
    for (let i = 0; i < 4; i++) expect(curve.x[i]).toBeCloseTo(i * Number(last) / 3, 12);
  });

  it("scales explicit XY pairs with standard delimiters and exponent notation", async () => {
    const response = await jcampPreview("##XFACTOR=0.1\n##YFACTOR=0.01\n##NPOINTS=2\n##XYPOINTS=(XY..XY)\n100,2E+2; 50,5E+1");
    expect(response.status, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout).curve).toEqual({ x: [10, 5], y: [2, 0.5] });
  });

  it.each([
    ["compressed rows", "##XYDATA=(XY..XY)\n10 1\n11 A2B3", /compressed/i],
    ["unsupported tuples", "##XYPOINTS=(XYZ..XYZ)\n10 1 2", /unsupported/i],
    ["compound spectra", "##DATA TYPE=LINK\n##XYDATA=(XY..XY)\n1 2", /compound/i],
    ["NTUPLES", "##NTUPLES=NMR SPECTRUM\n##DATA TABLE=(X++(Y..Y))\n1 2", /NTUPLES/i],
    ["incomplete pairs", "##XYPOINTS=(XY..XY)\n1 2 3", /incomplete/i],
    ["truncated data", "##FIRSTX=1\n##LASTX=3\n##NPOINTS=3\n##XYDATA=(X++(Y..Y))\n1 2 3", /count/i],
    ["missing spacing", "##XYDATA=(X++(Y..Y))\n1 2 3", /required/i],
    ["contradictory row checkpoints", "##FIRSTX=1\n##LASTX=2\n##NPOINTS=2\n##XYDATA=(X++(Y..Y))\n1 2\n9 3", /disagrees/i],
  ])("rejects %s instead of plotting partial or fabricated data", async (_name, records, error) => {
    const response = await jcampPreview(records as string);
    expect(response.status).toBe(5);
    expect(response.stderr).toMatch(error as RegExp);
    expect(response.stdout).toBe("");
  });

  it("exits 4 on a missing file", async () => {
    const res = await runSciHelper("massspec", "summarize", [path.join(FIX, "nope.mgf")]);
    expect(res.status).toBe(4);
  });

  // "tiny.pwiz.1.1.mzML" from pyteomics' own test suite (~25KB, ProteoWizard tiny example).
  it.runIf(depsOk && fs.existsSync(mzmlPath))("summarizes an mzML run with an MS1 chromatogram", async () => {
    const res = await runSciHelper("massspec", "summarize", [mzmlPath]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mzml");
    expect(d.n_spectra).toBe(4);
    expect(d.chromatogram).not.toBeNull();
    expect(d.chromatogram.x.length).toBeGreaterThan(0);
  }, 15000);

  // "test.mzXML" from pyteomics' own test suite (~16KB).
  it.runIf(depsOk && fs.existsSync(mzxmlPath))("summarizes an mzXML run", async () => {
    const res = await runSciHelper("massspec", "summarize", [mzxmlPath]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mzxml");
    expect(d.n_spectra).toBe(2);
    expect(d.spectra.length).toBeGreaterThan(0);
  }, 15000);
});
