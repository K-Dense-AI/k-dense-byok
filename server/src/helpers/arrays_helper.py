"""HDF5 / Parquet / npy·npz / NetCDF array & table preview helper.

Usage: python arrays_helper.py summarize <path>  -> JSON to stdout
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

MAX_HDF5_NODES = 500
MAX_PARQUET_COLS = 50
MAX_PARQUET_ROWS = 50
MAX_NDARRAY_PREVIEW = 100
MAX_NETCDF_VARS = 200

_NUMERIC_KINDS = set("iuf")  # numpy dtype.kind: signed/unsigned int, float


def _need(module_name: str, pip_name: str | None = None):
    try:
        __import__(module_name)
    except ImportError as exc:
        sys.stderr.write(f"{pip_name or module_name} not installed: {exc}\n")
        sys.exit(3)


def summarize_hdf5(path: Path) -> dict:
    _need("h5py")
    import h5py

    tree: list[dict] = []
    truncated = False

    def visit_group(group, prefix: str):
        nonlocal truncated
        for name in group.keys():
            if len(tree) >= MAX_HDF5_NODES:
                truncated = True
                return
            item = group[name]
            node_path = f"{prefix}/{name}"
            if isinstance(item, h5py.Group):
                attrs = {k: str(v) for k, v in item.attrs.items()}
                tree.append({"path": node_path, "type": "group", **({"attrs": attrs} if attrs else {})})
                if len(tree) >= MAX_HDF5_NODES:
                    truncated = True
                    return
                visit_group(item, node_path)
            else:  # Dataset
                attrs = {k: str(v) for k, v in item.attrs.items()}
                tree.append({
                    "path": node_path,
                    "type": "dataset",
                    "shape": list(item.shape),
                    "dtype": str(item.dtype),
                    **({"attrs": attrs} if attrs else {}),
                })
            if len(tree) >= MAX_HDF5_NODES:
                truncated = True
                return

    with h5py.File(path, "r") as f:
        visit_group(f, "")

    return {
        "format": "hdf5",
        "kind": "tree",
        "file_size": path.stat().st_size,
        "tree": tree,
        "truncated": truncated,
    }


def _stringify_cell(v):
    if v is None:
        return None
    return str(v)


def summarize_parquet(path: Path) -> dict:
    _need("pyarrow")
    import pyarrow.parquet as pq

    meta = pq.read_metadata(path)
    schema = meta.schema.to_arrow_schema()
    columns = [{"name": name, "dtype": str(schema.field(name).type)} for name in schema.names]
    num_rows = meta.num_rows
    num_columns = len(schema.names)

    table = pq.read_table(path, columns=schema.names[:MAX_PARQUET_COLS] if num_columns > MAX_PARQUET_COLS else None)
    head_table = table.slice(0, MAX_PARQUET_ROWS)
    rows = head_table.to_pylist()
    col_names = [c["name"] for c in columns[:MAX_PARQUET_COLS]]
    head = [[_stringify_cell(row.get(name)) for name in col_names] for row in rows]

    return {
        "format": "parquet",
        "kind": "table",
        "file_size": path.stat().st_size,
        "num_rows": num_rows,
        "num_columns": num_columns,
        "columns": columns[:MAX_PARQUET_COLS],
        "head": head,
    }


def _describe_ndarray(name: str, arr) -> dict:
    import numpy as np

    dtype = arr.dtype
    is_numeric = dtype.kind in _NUMERIC_KINDS
    flat = arr.ravel()
    preview_vals = flat[:MAX_NDARRAY_PREVIEW]
    if is_numeric:
        preview = [float(v) for v in preview_vals.tolist()]
        min_v = float(np.nanmin(arr)) if arr.size else None
        max_v = float(np.nanmax(arr)) if arr.size else None
        mean_v = float(np.nanmean(arr)) if arr.size else None
    else:
        preview = [str(v) for v in preview_vals.tolist()]
        min_v = max_v = mean_v = None
    return {
        "name": name,
        "shape": list(arr.shape),
        "dtype": str(dtype),
        "min": min_v,
        "max": max_v,
        "mean": mean_v,
        "preview": preview,
    }


def summarize_npy(path: Path) -> dict:
    _need("numpy")
    import numpy as np

    arr = np.load(path, allow_pickle=False)
    return {
        "format": "npy",
        "kind": "ndarray",
        "file_size": path.stat().st_size,
        "arrays": [_describe_ndarray("", arr)],
    }


def summarize_npz(path: Path) -> dict:
    _need("numpy")
    import numpy as np

    with np.load(path, allow_pickle=False) as npz:
        arrays = [_describe_ndarray(name, npz[name]) for name in npz.files]

    return {
        "format": "npz",
        "kind": "ndarray",
        "file_size": path.stat().st_size,
        "arrays": arrays,
    }


def summarize_netcdf(path: Path) -> dict:
    _need("netCDF4")
    import netCDF4

    ds = netCDF4.Dataset(str(path), "r")
    try:
        dimensions = {name: dim.size for name, dim in ds.dimensions.items()}
        variables = []
        for name, var in ds.variables.items():
            if len(variables) >= MAX_NETCDF_VARS:
                break
            attrs = {attr: str(getattr(var, attr)) for attr in var.ncattrs()}
            variables.append({
                "name": name,
                "dims": list(var.dimensions),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": attrs,
            })
        global_attrs = {attr: str(getattr(ds, attr)) for attr in ds.ncattrs()}
    finally:
        ds.close()

    return {
        "format": "netcdf",
        "kind": "variables",
        "file_size": path.stat().st_size,
        "dimensions": dimensions,
        "variables": variables,
        "global_attrs": global_attrs,
    }


_EXT_DISPATCH = {
    "h5": summarize_hdf5,
    "hdf5": summarize_hdf5,
    "parquet": summarize_parquet,
    "npy": summarize_npy,
    "npz": summarize_npz,
    "nc": summarize_netcdf,
    "nc4": summarize_netcdf,
    "cdf": summarize_netcdf,
}


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] != "summarize":
        sys.stderr.write("usage: arrays_helper.py summarize <path>\n")
        sys.exit(1)
    p = Path(sys.argv[2])
    if not p.exists():
        sys.stderr.write(f"File not found: {p}\n")
        sys.exit(4)
    ext = p.suffix.lower().lstrip(".")
    fn = _EXT_DISPATCH.get(ext)
    if fn is None:
        sys.stderr.write(f"Unsupported extension: {ext}\n")
        sys.exit(5)
    try:
        data = fn(p)
        sys.stdout.write(json.dumps(data))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(5)


if __name__ == "__main__":
    main()
