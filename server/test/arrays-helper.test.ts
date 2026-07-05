import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk =
  spawnSync(helperPython(), ["-c", "import h5py,pyarrow,netCDF4"], { stdio: "ignore" }).status === 0;

describe("arrays_helper", () => {
  it.runIf(depsOk)("summarizes an .npy array", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "sample.npy")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("npy");
    expect(d.kind).toBe("ndarray");
    expect(d.arrays.length).toBe(1);
    const arr = d.arrays[0];
    expect(arr.name).toBe("");
    expect(arr.shape).toEqual([3, 4]);
    expect(arr.dtype).toContain("float");
    expect(arr.preview.length).toBe(12);
  }, 15000);

  it.runIf(depsOk)("summarizes an .npz archive with multiple arrays", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "sample.npz")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("npz");
    expect(d.kind).toBe("ndarray");
    const names = d.arrays.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(["a", "b"]);
  }, 15000);

  it.runIf(depsOk)("summarizes an HDF5 file as a tree", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "sample.h5")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("hdf5");
    expect(d.kind).toBe("tree");
    const ds = d.tree.find((n: { path: string }) => n.path.endsWith("/grp/ds"));
    expect(ds).toBeDefined();
    expect(ds.type).toBe("dataset");
  }, 15000);

  it.runIf(depsOk)("summarizes a Parquet file as a table", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "sample.parquet")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("parquet");
    expect(d.kind).toBe("table");
    expect(d.num_rows).toBe(3);
    const names = d.columns.map((c: { name: string }) => c.name);
    expect(names).toEqual(["x", "y"]);
    expect(d.head.length).toBe(3);
  }, 15000);

  it.runIf(depsOk)("summarizes a NetCDF file as variables", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "sample.nc")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("netcdf");
    expect(d.kind).toBe("variables");
    const temp = d.variables.find((v: { name: string }) => v.name === "temp");
    expect(temp).toBeDefined();
    expect(temp.dims).toEqual(["t"]);
    expect(d.global_attrs.title).toBe("demo");
    expect(d.num_variables).toBe(1);
    expect(d.truncated).toBe(false);
  }, 15000);

  it("exits 4 on missing file", () => {
    const res = runSciHelper("arrays", "summarize", [path.join(FIX, "does-not-exist.h5")]);
    expect(res.status).toBe(4);
  });
});
