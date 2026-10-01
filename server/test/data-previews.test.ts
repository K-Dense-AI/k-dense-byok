import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { helperPython } from "../src/helpers-env.ts";
import { runSciHelper } from "../src/api/sci-helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-data-previews-"));
const depsOk = spawnSync(helperPython(), ["-c", "import numpy, scipy, h5py, netCDF4, pyarrow, openpyxl, astropy"], { stdio: "ignore" }).status === 0;
beforeAll(() => {
  if (!depsOk) return;
  const generated = spawnSync(helperPython(), [path.join(__dirname, "fixtures/create-data-previews.py"), root], { encoding: "utf8" });
  expect(generated.status, generated.stderr).toBe(0);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
async function preview(kind: string, name: string, key = "", slice = 0) {
  const res = await runSciHelper(kind, "summarize", [path.join(root, name), key, String(slice)]);
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

describe.runIf(depsOk)("bounded scientific data previews", () => {
  it("switches XLSX sheets, bounds rows and does not evaluate formulas", async () => {
    const first = await preview("tables", "study.xlsx");
    expect(first.collections).toEqual(["Measurements", "Conditions"]);
    expect(first.head).toHaveLength(200);
    expect(first.head[0]).toEqual(["sample-0", 0, null]);
    expect(first.rows_truncated).toBe(true);
    expect(first.num_rows).toBeNull();
    const second = await preview("tables", "study.xlsx", "Conditions");
    expect(second.head).toEqual([["control", 24]]);
    expect(second.num_rows).toBe(1);
  });
  it("bounds JSON Lines and preserves nested, missing and large integer values", async () => {
    const data = await preview("tables", "records.jsonl");
    expect(data.head).toHaveLength(200);
    expect(data.rows_truncated).toBe(true);
    expect(data.num_rows).toBeNull();
    const types = await preview("tables", "types.jsonl");
    expect(types.head[0]).toEqual(["9007199254740993", null, false, "[1, 2]"]);
    expect((await preview("tables", "empty.jsonl")).head).toEqual([]);
    const bad = await runSciHelper("tables", "summarize", [path.join(root, "bad.ndjson")]);
    expect(bad.status).toBe(5);
    expect(bad.stderr).toContain("line 2");
  });
  it("reads SQLite tables with quoted names, excludes views, and leaves bytes unchanged", async () => {
    const before = fs.readFileSync(path.join(root, "study.db"));
    const data = await preview("tables", "study.db");
    expect(data.collections).toEqual(["measurements", 'quoted"table']);
    expect(data.head[0]).toEqual(["sample-0", 0, "[binary: 3 bytes]"]);
    expect(data.head).toHaveLength(200);
    expect((await preview("tables", "study.db", 'quoted"table')).head).toEqual([[42]]);
    expect(fs.readFileSync(path.join(root, "study.db"))).toEqual(before);
    expect((await runSciHelper("tables", "summarize", [path.join(root, "study.db"), "hidden_view"])).status).toBe(5);
  });
  it("includes SQLite generated columns and tables whose names start with sqlite without an underscore", async () => {
    const data = await preview("tables", "generated.db");
    expect(data.collections).toEqual(["sqliteData"]);
    expect(data.columns).toEqual([
      { name: "raw", dtype: "REAL" },
      { name: "calibrated", dtype: "REAL" },
      { name: "offset", dtype: "REAL" },
    ]);
    expect(data.head).toEqual([[2, 4, 1]]);
    expect(data.num_columns).toBe(3);
    expect(data.columns_truncated).toBe(false);
  });
  it.each(["data.arrow", "data.ipc", "data.feather"])("reads a bounded sample across record batches in %s", async name => {
    const data = await preview("tables", name);
    expect(data.head).toHaveLength(200);
    expect(data.head[199]).toEqual([199, 99.5]);
    expect(data.rows_truncated).toBe(true);
    expect(data.columns.map((col: { name: string }) => col.name)).toEqual(["sample", "value"]);
  });
  it("samples Parquet batches while retaining the metadata row count", async () => {
    const data = await preview("arrays", "data.parquet");
    expect(data.num_rows).toBe(205);
    expect(data.head).toHaveLength(200);
    expect(data.head[199]).toEqual(["199", "99.5"]);
  });
  it("selects NumPy slices and emits strict JSON for nonfinite values", async () => {
    const cube = await preview("arrays", "cube.npy", "", 1);
    expect(cube.plot.values).toEqual([[12, 13, 14, 15], [16, 17, 18, 19], [20, 21, 22, 23]]);
    expect(cube.plot.leading_indices).toEqual([1]);
    expect(cube.plot.stats.mean).toBe(17.5);
    const missing = await preview("arrays", "missing.npy");
    expect(missing.plot.values).toEqual([[1, null, null, null, 5]]);
    expect(missing.plot.missing).toBe(3);
    expect((await preview("arrays", "huge-values.npy")).plot.stats.mean).toBe(1e308);
    expect((await runSciHelper("arrays", "summarize", [path.join(root, "cube.npy"), "", "2"])).status).toBe(5);
  });
  it("previews NPZ numeric entries while refusing object deserialization", async () => {
    expect((await preview("arrays", "archive.npz", "vector")).plot.values[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const data = await preview("arrays", "archive.npz", "objects");
    expect(data.plot_note).toContain("pickle");
    expect(data.plot).toBeUndefined();
  });
  it("preserves exact integers beyond the browser numeric range in the selected slice", async () => {
    const safe = await preview("arrays", "integers.npz", "safe");
    expect(safe.plot.values).toEqual([[-9007199254740991, 9007199254740991]]);
    expect((await preview("arrays", "integers.npz", "signed", 0)).plot.values).toEqual([[1, 2]]);
    const signed = await preview("arrays", "integers.npz", "signed", 1);
    expect(signed.plot).toBeNull();
    expect(signed.plot_note).toContain("precision");
    expect(signed.value_preview).toEqual(["9007199254740993", "9007199254740995"]);
    const unsigned = await preview("arrays", "integers.npz", "unsigned");
    expect(unsigned.plot).toBeNull();
    expect(unsigned.value_preview).toEqual(["18446744073709551615"]);
  });
  it("retains bounded value previews for scalar and text NumPy arrays", async () => {
    expect((await preview("arrays", "scalar.npy")).value_preview).toEqual(["42"]);
    expect((await preview("arrays", "text.npy")).value_preview).toEqual(["control", "treated"]);
  });
  it("slices large HDF5 datasets without full materialization or following links", async () => {
    const data = await preview("arrays", "arrays.h5", "/large");
    expect(data.plot.sampled).toBe(true);
    expect(data.plot.x.length).toBeLessThanOrEqual(128);
    expect(data.plot.stats).toEqual({ min: 4, max: 4, mean: 4 });
    expect(data.tree.find((node: { path: string }) => node.path === "/external").type).toBe("link");
    expect((await preview("arrays", "arrays.h5", "/science/cube", 1)).plot.values[0]).toEqual([12, 13, 14, 15]);
  });
  it("preserves NetCDF masks instead of plotting fill values", async () => {
    const data = await preview("arrays", "weather.nc", "temp");
    expect(data.plot.values).toEqual([[2, null, 6]]);
    expect(data.plot.stats.mean).toBe(4);
  });
  it("supports classic and HDF5 MATLAB files", async () => {
    const data = await preview("arrays", "arrays.mat", "cube", 1);
    expect(data.plot.values[0]).toEqual([12, 13, 14, 15]);
    expect((await preview("arrays", "arrays.mat", "vector")).plot.kind).toBe("line");
    expect((await preview("arrays", "arrays.mat", "label")).plot_note).toContain("numeric");
    expect((await preview("arrays", "modern.mat", "/signal", 1)).plot.values[0]).toEqual([12, 13, 14, 15]);
  });
  it("samples a sparse matrix without densifying the million-by-million source", async () => {
    const data = await preview("arrays", "sparse.mtx");
    expect(data.plot.shape).toEqual([1000000, 1000000]);
    expect(data.plot.sampled).toBe(true);
    expect(data.plot.values[0][0]).toBe(3);
  });
  it("selects FITS image HDUs and applies unsigned integer scaling", async () => {
    expect((await preview("arrays", "image.fits", "1", 1)).plot.values[0]).toEqual([12, 13, 14, 15]);
    expect((await preview("arrays", "scaled.fits")).plot.values[0]).toEqual([0, 1, 2, 3]);
  });
});
