import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk =
  spawnSync(helperPython(), ["-c", "import pydicom,nibabel,tifffile,PIL"], { stdio: "ignore" }).status === 0;

function tmpOut(name: string): string {
  return path.join(os.tmpdir(), `kady-imaging-test-${process.pid}-${Date.now()}-${name}`);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("imaging_helper", () => {
  it.runIf(depsOk)("summarizes a NIfTI volume", () => {
    const res = runSciHelper("imaging", "summarize", [path.join(FIX, "sample.nii.gz")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("nifti");
    expect(d.axes.map((a: { name: string }) => a.name)).toEqual(["sagittal", "coronal", "axial"]);
    expect(d.axes.map((a: { size: number }) => a.size)).toEqual([4, 5, 6]);
    expect(d.default_axis).toBe("axial");
  }, 15000);

  it.runIf(depsOk)("renders a NIfTI axial slice to PNG", () => {
    const out = tmpOut("nifti.png");
    try {
      const res = runSciHelper("imaging", "render", [path.join(FIX, "sample.nii.gz"), "2", out, "axial"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it.runIf(depsOk)("summarizes a DICOM file without leaking PHI", () => {
    const res = runSciHelper("imaging", "summarize", [path.join(FIX, "sample.dcm")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("dicom");
    expect(d.meta.Modality).toBeDefined();
    expect(Object.keys(d.meta)).not.toContain("PatientName");
    expect(Object.keys(d.meta)).not.toContain("PatientID");
    expect(Object.keys(d.meta)).not.toContain("PatientBirthDate");
  }, 15000);

  it.runIf(depsOk)("renders a DICOM frame to PNG", () => {
    const out = tmpOut("dicom.png");
    try {
      const res = runSciHelper("imaging", "render", [path.join(FIX, "sample.dcm"), "0", out, "-"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it.runIf(depsOk)("summarizes a TIFF stack", () => {
    const res = runSciHelper("imaging", "summarize", [path.join(FIX, "sample.tif")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("tiff");
    expect(d.axes[0].size).toBe(3);
  }, 15000);

  it.runIf(depsOk)("renders a TIFF page to PNG", () => {
    const out = tmpOut("tiff.png");
    try {
      const res = runSciHelper("imaging", "render", [path.join(FIX, "sample.tif"), "0", out, "-"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it("exits 4 on missing file", () => {
    const res = runSciHelper("imaging", "summarize", [path.join(FIX, "does-not-exist.dcm")]);
    expect(res.status).toBe(4);
  });

  it.runIf(depsOk)("exits 4 on out-of-range NIfTI slice index", () => {
    const out = tmpOut("oor.png");
    const res = runSciHelper("imaging", "render", [path.join(FIX, "sample.nii.gz"), "99", out, "axial"]);
    expect(res.status).toBe(4);
    expect(fs.existsSync(out)).toBe(false);
  });

  it.runIf(depsOk)("exits 4 on out-of-range DICOM frame index", () => {
    const out = tmpOut("oor-dcm.png");
    const res = runSciHelper("imaging", "render", [path.join(FIX, "sample.dcm"), "5", out, "-"]);
    expect(res.status).toBe(4);
    expect(fs.existsSync(out)).toBe(false);
  });
});
