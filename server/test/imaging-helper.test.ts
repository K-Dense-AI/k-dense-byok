import { afterAll, beforeAll, describe, it, expect } from "vitest";
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
  it.runIf(depsOk)("summarizes a NIfTI volume", async () => {
    const res = await runSciHelper("imaging", "summarize", [path.join(FIX, "sample.nii.gz")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("nifti");
    expect(d.axes.map((a: { name: string }) => a.name)).toEqual(["sagittal", "coronal", "axial"]);
    expect(d.axes.map((a: { size: number }) => a.size)).toEqual([4, 5, 6]);
    expect(d.default_axis).toBe("axial");
  }, 15000);

  it.runIf(depsOk)("renders a NIfTI axial slice to PNG", async () => {
    const out = tmpOut("nifti.png");
    try {
      const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.nii.gz"), "2", out, "axial"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  describe.runIf(depsOk)("NIfTI affine-aware planes", () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-nifti-orientation-"));
      // Real NIfTI files encode identical world-space voxels using different
      // storage axis permutations and signs. A preview must be invariant to
      // those storage choices (NiBabel's documented orientation transforms).
      const generated = spawnSync(helperPython(), ["-c", `
import sys
from pathlib import Path
import numpy as np
import nibabel as nib
root = Path(sys.argv[1])
data = np.arange(120, dtype=np.int16).reshape(4, 5, 6)
image = nib.Nifti1Image(data, np.diag([2., 3., 4., 1.]))
nib.save(image, root / 'canonical.nii.gz')
for name, transform in [('permuted', [[2, 1], [0, 1], [1, 1]]), ('flipped', [[2, -1], [0, 1], [1, -1]])]:
    nib.save(image.as_reoriented(np.array(transform)), root / (name + '.nii.gz'))
theta = np.deg2rad(30)
affine = np.array([[np.cos(theta), -np.sin(theta), 0, 0], [np.sin(theta), np.cos(theta), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
nib.save(nib.Nifti1Image(data, affine), root / 'oblique.nii.gz')
unknown = nib.Nifti1Image(data, np.eye(4))
unknown.set_qform(None, code=0)
unknown.set_sform(None, code=0)
nib.save(unknown, root / 'unknown.nii.gz')
`, dir], { encoding: "utf8" });
      expect(generated.status, generated.stderr).toBe(0);
    });
    afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    it.each(["permuted", "flipped"])("uses anatomical slice counts for %s storage", async name => {
      const result = await runSciHelper("imaging", "summarize", [path.join(dir, `${name}.nii.gz`)]);
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary.axes).toEqual([{ name: "sagittal", size: 4 }, { name: "coronal", size: 5 }, { name: "axial", size: 6 }]);
      expect(summary.meta.voxel_sizes).toEqual([2, 3, 4]);
    });

    it.each(["sagittal", "coronal", "axial"])("renders the same oriented %s pixels across storage permutations and flips", async axis => {
      const images: Buffer[] = [];
      for (const name of ["canonical", "permuted", "flipped"]) {
        const out = path.join(dir, `${name}-${axis}.png`);
        const result = await runSciHelper("imaging", "render", [path.join(dir, `${name}.nii.gz`), "1", out, axis]);
        expect(result.status, result.stderr).toBe(0);
        images.push(fs.readFileSync(out));
      }
      expect(images[1]).toEqual(images[0]);
      expect(images[2]).toEqual(images[0]);
    }, 15000);

    it.each(["oblique", "unknown"])("labels %s volume planes as native voxels and refuses anatomical claims", async name => {
      const file = path.join(dir, `${name}.nii.gz`);
      const summaryResult = await runSciHelper("imaging", "summarize", [file]);
      expect(summaryResult.status, summaryResult.stderr).toBe(0);
      const summary = JSON.parse(summaryResult.stdout);
      expect(summary.axes).toEqual([{ name: "voxel axis 1", size: 4 }, { name: "voxel axis 2", size: 5 }, { name: "voxel axis 3", size: 6 }]);
      expect(summary.meta.orientation).toContain("not reconstructed anatomical planes");
      const out = path.join(dir, `${name}.png`);
      expect((await runSciHelper("imaging", "render", [file, "2", out, summary.default_axis])).status).toBe(0);
      expect(fs.readFileSync(out).subarray(0, 4)).toEqual(PNG_MAGIC);
      expect((await runSciHelper("imaging", "render", [file, "2", out, "axial"])).status).toBe(5);
    });
  });

  it.runIf(depsOk)("summarizes a DICOM file without leaking PHI", async () => {
    const res = await runSciHelper("imaging", "summarize", [path.join(FIX, "sample.dcm")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("dicom");
    expect(d.meta.Modality).toBeDefined();
    expect(Object.keys(d.meta)).not.toContain("PatientName");
    expect(Object.keys(d.meta)).not.toContain("PatientID");
    expect(Object.keys(d.meta)).not.toContain("PatientBirthDate");
  }, 15000);

  it.runIf(depsOk)("renders a DICOM frame to PNG", async () => {
    const out = tmpOut("dicom.png");
    try {
      const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.dcm"), "0", out, "-"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it.runIf(depsOk)("summarizes a TIFF stack", async () => {
    const res = await runSciHelper("imaging", "summarize", [path.join(FIX, "sample.tif")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("tiff");
    expect(d.axes[0].size).toBe(3);
  }, 15000);

  it.runIf(depsOk)("renders a TIFF page to PNG", async () => {
    const out = tmpOut("tiff.png");
    try {
      const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.tif"), "0", out, "-"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it.runIf(depsOk)("summarizes an RGB TIFF as a single plane, not one page per sample", async () => {
    const res = await runSciHelper("imaging", "summarize", [path.join(FIX, "sample_rgb.tif")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("tiff");
    expect(d.axes[0].size).toBe(1);
  }, 15000);

  it.runIf(depsOk)("renders an RGB TIFF plane to PNG", async () => {
    const out = tmpOut("tiff-rgb.png");
    try {
      const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample_rgb.tif"), "0", out, "-"]);
      expect(res.status).toBe(0);
      const data = fs.readFileSync(out);
      expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 15000);

  it("exits 4 on missing file", async () => {
    const res = await runSciHelper("imaging", "summarize", [path.join(FIX, "does-not-exist.dcm")]);
    expect(res.status).toBe(4);
  });

  it.runIf(depsOk)("exits 4 on out-of-range NIfTI slice index", async () => {
    const out = tmpOut("oor.png");
    const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.nii.gz"), "99", out, "axial"]);
    expect(res.status).toBe(4);
    expect(fs.existsSync(out)).toBe(false);
  });

  it.runIf(depsOk)("exits 4 on out-of-range DICOM frame index", async () => {
    const out = tmpOut("oor-dcm.png");
    const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.dcm"), "5", out, "-"]);
    expect(res.status).toBe(4);
    expect(fs.existsSync(out)).toBe(false);
  });

  it.runIf(depsOk)("exits 4 on out-of-range TIFF page index", async () => {
    const out = tmpOut("oor-tiff.png");
    const res = await runSciHelper("imaging", "render", [path.join(FIX, "sample.tif"), "99", out, "-"]);
    expect(res.status).toBe(4);
    expect(fs.existsSync(out)).toBe(false);
  }, 15000);
});
