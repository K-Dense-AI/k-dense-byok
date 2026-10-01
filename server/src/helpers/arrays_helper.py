"""Scientific array previews with bounded numeric slices, never pickle loading.

Usage: arrays_helper.py summarize <path> [dataset-key] [flattened-leading-slice]
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import itertools
import json
import math
import sys
import zipfile
from pathlib import Path

MAX_NODES = 500
MAX_ARRAYS = 100
MAX_BYTES = 64 * 1024 * 1024
MAX_SIDE = 128
MAX_LINE = 1024
NUMERIC = set("biuf")


def _need(module):
    try:
        __import__(module)
    except ImportError as exc:
        sys.stderr.write(f"{module} not installed: {exc}\n")
        sys.exit(3)


def info(name, shape, dtype):
    return {"key": name, "name": name, "shape": list(shape or []), "dtype": str(dtype)}


def choose(datasets, key):
    if key and not any(d["key"] == key for d in datasets):
        raise ValueError("The selected dataset is no longer available")
    return next((d for d in datasets if d["key"] == key), datasets[0] if datasets else None)


def plot_array(shape, dtype, read, index):
    """Read only a strided plane; leading dimensions flatten in C order.

    read(tuple) may index a memmap, HDF5/NetCDF dataset, FITS section or sparse
    matrix. No ravel/full-array conversion occurs before slicing.
    """
    import numpy as np
    shape = tuple(shape)
    if np.dtype(dtype).kind not in NUMERIC:
        return None, "This dataset is not a real-valued numeric array.", None
    if not shape or any(n == 0 for n in shape):
        return None, "Scalar or empty dataset; no curve or heatmap to draw.", None
    slices = math.prod(shape[:-2]) if len(shape) > 2 else 1
    if slices > 2**53 - 1:
        return None, "This array has too many slices for the preview controls.", None
    if index < 0 or index >= slices:
        raise ValueError(f"Slice must be between 0 and {slices - 1}")
    leading = tuple(int(v) for v in np.unravel_index(index, shape[:-2])) if len(shape) > 2 else ()
    plane = shape[-2:] if len(shape) > 1 else (shape[0],)
    line = len(plane) == 1 or min(plane) == 1
    cap = MAX_LINE if line else MAX_SIDE
    strides = [max(1, math.ceil(n / cap)) for n in plane]
    selection = leading + tuple(slice(None, None, step) for step in strides)
    raw = read(selection)
    if hasattr(raw, "toarray"):
        raw = raw.toarray()
    sampled = np.ma.asarray(raw)
    if sampled.dtype.kind in "iu" and np.ma.any((sampled > 2**53 - 1) | (sampled < -(2**53 - 1))):
        # Converting int64/uint64 to float would alter values before JSON even
        # reaches the browser. Preserve exact bounded values from this slice.
        preview = ["—" if np.ma.is_masked(v) else str(v) for v in sampled.reshape(-1)[:100]]
        return None, "Integer values exceed browser numeric precision. Showing exact values from this slice's preview sample instead of a plot.", preview
    # NetCDF masked fill values must stay gaps, never look like observations.
    values = sampled.astype(float).filled(np.nan)
    if line:
        values = values.reshape(1, -1)
        axis = 0 if len(plane) == 1 or plane[-1] == 1 else 1
        xs = list(range(0, plane[axis], strides[axis]))
        ys = [0]
    else:
        xs = list(range(0, plane[-1], strides[-1]))
        ys = list(range(0, plane[-2], strides[-2]))
    finite = values[np.isfinite(values)]
    scale = float(abs(finite).max()) if finite.size else 0
    stats = {"min": float(finite.min()) if finite.size else None,
             "max": float(finite.max()) if finite.size else None,
             "mean": float((finite / scale).mean() * scale) if scale else (0.0 if finite.size else None)}
    return {
        "kind": "line" if line else "heatmap", "values": [[float(v) if np.isfinite(v) else None for v in row] for row in values],
        "x": xs, "y": ys, "shape": list(shape), "slice": index, "slices": slices,
        "leading_indices": list(leading), "sampled": any(step > 1 for step in strides),
        "stats": stats, "missing": int(values.size - finite.size),
    }, None, None


def attach(summary, datasets, key, index, opener):
    summary["datasets"] = datasets
    selected = choose(datasets, key)
    summary["selected"] = selected["key"] if selected else ""
    if selected:
        if selected.get("unavailable"):
            summary["plot_note"] = selected["unavailable"]
        else:
            shape, dtype, read = opener(selected)
            summary["plot"], summary["plot_note"], exact_preview = plot_array(shape, dtype, read, index)
            if exact_preview is not None:
                summary["value_preview"] = exact_preview
            elif not summary["plot"]:
                import numpy as np
                dt = np.dtype(dtype)
                # Preserve scalar/text value previews without reading a whole
                # array or dereferencing object/structured payloads.
                if dt.kind in set("biufSU") and dt.itemsize <= 4096:
                    if not shape:
                        raw = np.asarray(read(())).reshape(-1)
                    elif all(shape):
                        count = min(100, max(1, 4096 // max(1, dt.itemsize)))
                        leading = tuple(int(v) for v in np.unravel_index(index, shape[:-2])) if len(shape) > 2 else ()
                        row = (0,) if len(shape) > 1 else ()
                        raw = np.asarray(read(leading + row + (slice(0, count),))).reshape(-1)
                    else:
                        raw = []
                    summary["value_preview"] = [str(value)[:512] for value in raw]
    else:
        summary["plot_note"] = "No numeric datasets found in this file."
    return summary


def describe(d, plot=None):
    stats = (plot or {}).get("stats", {"min": None, "max": None, "mean": None})
    preview = list(itertools.islice(itertools.chain.from_iterable((plot or {}).get("values", [])), 100))
    return {"name": d["name"], "shape": d["shape"], "dtype": d["dtype"], **stats, "preview": preview}


def attributes(obj):
    # Bound both count and content; do not materialize giant attribute arrays.
    result = {}
    for name in itertools.islice(obj.attrs, 30):
        attr = obj.attrs.get_id(name)
        if attr.get_storage_size() > 4096:
            result[name] = "(large attribute omitted)"
        else:
            result[name] = str(obj.attrs[name])[:512]
    return result


def summarize_hdf5(path, key="", index=0):
    _need("h5py")
    import h5py
    tree, datasets, seen = [], [], set()
    truncated = False
    with h5py.File(path, "r") as f:
        def visit(group, prefix, depth=0):
            nonlocal truncated
            address = h5py.h5o.get_info(group.id).addr
            if address in seen or depth > 32:
                return
            seen.add(address)
            for name in group:
                if len(tree) >= MAX_NODES:
                    truncated = True
                    return
                node_path = f"{prefix}/{name}"
                # Never follow external/soft links or virtual/external storage.
                if not isinstance(group.get(name, getlink=True), h5py.HardLink):
                    tree.append({"path": node_path, "type": "link", "dtype": "link not followed"})
                    continue
                item = group[name]
                if isinstance(item, h5py.Group):
                    tree.append({"path": node_path, "type": "group", "attrs": attributes(item)})
                    visit(item, node_path, depth + 1)
                else:
                    d = info(node_path, item.shape, item.dtype)
                    if item.is_virtual or item.external:
                        d["unavailable"] = "External and virtual dataset storage is not previewed."
                    tree.append({"path": node_path, "type": "dataset", "shape": d["shape"], "dtype": d["dtype"], "attrs": attributes(item)})
                    datasets.append(d)
        visit(f, "")
        summary = {"format": "hdf5", "kind": "tree", "tree": tree, "truncated": truncated}
        def opener(d):
            arr = f[d["key"]]
            return arr.shape or (), arr.dtype, arr.__getitem__
        return attach(summary, datasets, key, index, opener)


def summarize_parquet(path, key="", index=0):
    _need("pyarrow")
    import pyarrow.parquet as pq
    if key:
        raise ValueError("Parquet has no datasets to select")
    # The old preview read the entire table before slicing to 50 rows.
    with pq.ParquetFile(path) as file:
        schema = file.schema_arrow
        names = schema.names[:50]
        batch = next(file.iter_batches(batch_size=201, columns=names), None)
        columns = [{"name": field.name, "dtype": str(field.type)} for field in list(schema)[:50]]
        def cell(v):
            if v is None:
                return None
            return str(v)[:512]
        head = [] if batch is None else [[cell(v) for v in row] for row in zip(*(col.to_pylist() for col in batch.columns))][:200]
        return {"format": "parquet", "kind": "table", "num_rows": file.metadata.num_rows,
                "num_columns": len(schema), "columns": columns, "head": head,
                "rows_truncated": file.metadata.num_rows > len(head), "columns_truncated": len(schema) > 50,
                "cell_limit": 512}


def summarize_npy(path, key="", index=0):
    _need("numpy")
    import numpy as np
    arr = np.load(path, mmap_mode="r", allow_pickle=False)
    d = info("", arr.shape, arr.dtype)
    result = attach({"format": "npy", "kind": "ndarray"}, [d], key, index,
                    lambda _: (arr.shape, arr.dtype, arr.__getitem__))
    result["arrays"] = [describe(d, result.get("plot"))]
    return result


def summarize_npz(path, key="", index=0):
    _need("numpy")
    import numpy as np
    datasets = []
    with zipfile.ZipFile(path) as archive:
        members = [m for m in archive.infolist() if m.filename.endswith(".npy")]
        for member in members[:MAX_ARRAYS]:
            with archive.open(member) as stream:
                version = np.lib.format.read_magic(stream)
                if version not in ((1, 0), (2, 0)):
                    raise ValueError("NPZ previews support NumPy header versions 1 and 2")
                reader = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
                shape, _, dtype = reader(stream)
            d = info(member.filename[:-4], shape, dtype)
            if dtype.hasobject:
                d["unavailable"] = "Object arrays are not loaded because they require pickle."
            elif member.file_size > MAX_BYTES or math.prod(shape) * dtype.itemsize > MAX_BYTES:
                d["unavailable"] = "This array exceeds the 64 MiB expanded preview limit."
            datasets.append(d)
    with np.load(path, allow_pickle=False) as arrays:
        def opener(d):
            arr = arrays[d["key"]]
            return arr.shape, arr.dtype, arr.__getitem__
        result = attach({"format": "npz", "kind": "ndarray", "truncated": len(members) > MAX_ARRAYS}, datasets, key, index, opener)
        result["arrays"] = [describe(d, result.get("plot") if d["key"] == result["selected"] else None) for d in datasets]
        return result


def summarize_netcdf(path, key="", index=0):
    _need("netCDF4")
    import netCDF4
    with netCDF4.Dataset(str(path), "r") as ds:
        variables, datasets = [], []
        for name, var in itertools.islice(ds.variables.items(), 200):
            d = info(name, var.shape, var.dtype)
            datasets.append(d)
            variables.append({"name": name, "dims": list(var.dimensions), "shape": d["shape"], "dtype": d["dtype"], "attrs": {}})
        result = {"format": "netcdf", "kind": "variables", "dimensions": {name: dim.size for name, dim in ds.dimensions.items()},
                  "variables": variables, "num_variables": len(ds.variables), "truncated": len(ds.variables) > 200,
                  "global_attrs": {attr: str(ds.getncattr(attr))[:512] for attr in ds.ncattrs()[:30]}}
        def opener(d):
            arr = ds.variables[d["key"]]
            return arr.shape, arr.dtype, arr.__getitem__
        return attach(result, datasets, key, index, opener)


def summarize_mat(path, key="", index=0):
    _need("scipy")
    _need("h5py")
    import h5py
    import numpy as np
    from scipy.io import whosmat, loadmat
    from scipy import sparse
    if h5py.is_hdf5(path):
        result = summarize_hdf5(path, key, index)
        result["format"] = "MATLAB v7.3 (HDF5 storage axes)"
        return result
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("MATLAB preview supports files up to 64 MiB")
    variables = whosmat(path)
    datasets = []
    numeric_classes = {"double", "single", "logical", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"}
    for name, shape, dtype in variables[:MAX_ARRAYS]:
        d = info(name, shape, dtype)
        if dtype not in numeric_classes:
            d["unavailable"] = "Only dense numeric MATLAB variables are previewed."
        elif math.prod(shape) * 16 > MAX_BYTES:
            d["unavailable"] = "Variable exceeds the 64 MiB expanded preview limit."
        datasets.append(d)
    def opener(d):
        arr = loadmat(path, variable_names=[d["key"]], verify_compressed_data_integrity=True)[d["key"]]
        if sparse.issparse(arr) or not isinstance(arr, np.ndarray):
            raise ValueError("Only dense numeric MATLAB variables are previewed")
        return arr.shape, arr.dtype, arr.__getitem__
    result = attach({"format": "MATLAB", "kind": "ndarray", "truncated": len(variables) > MAX_ARRAYS}, datasets, key, index, opener)
    result["arrays"] = [describe(d, result.get("plot") if d["key"] == result["selected"] else None) for d in datasets]
    return result


def summarize_mtx(path, key="", index=0):
    _need("scipy")
    from scipy.io import mminfo, mmread
    from scipy import sparse
    rows, cols, entries, storage, _, _ = mminfo(path)
    if path.stat().st_size > MAX_BYTES or entries > 2_000_000 or max(rows, cols) > 2_000_000:
        raise ValueError("Matrix Market preview limit: 64 MiB, 2 million entries / axis")
    if storage == "array" and rows * cols * 16 > MAX_BYTES:
        raise ValueError("Dense matrix exceeds the 64 MiB preview limit")
    arr = mmread(path)
    if sparse.issparse(arr):
        arr = arr.tocsr()
    d = info("matrix", arr.shape, arr.dtype)
    result = attach({"format": "Matrix Market", "kind": "ndarray"}, [d], key, index,
                    lambda _: (arr.shape, arr.dtype, arr.__getitem__))
    result["arrays"] = [describe(d, result.get("plot"))]
    return result


def summarize_fits(path, key="", index=0):
    _need("astropy")
    from astropy.io import fits
    datasets = []
    # section reads bounded image regions, including scaled integer images.
    with fits.open(path, mode="readonly", memmap=False, lazy_load_hdus=True) as hdus:
        truncated = False
        for i, hdu in enumerate(hdus):
            if i >= MAX_ARRAYS:
                truncated = True
                break
            if not isinstance(hdu, (fits.PrimaryHDU, fits.ImageHDU, fits.CompImageHDU)) or not hdu.shape:
                continue
            dtype = {8: "uint8", 16: "int16", 32: "int32", 64: "int64", -32: "float32", -64: "float64"}.get(hdu.header.get("BITPIX"), "unknown")
            d = info(str(i), hdu.shape, dtype)
            d["name"] = f"HDU {i}: {hdu.name}"
            datasets.append(d)
        result = attach({"format": "FITS image", "kind": "ndarray", "truncated": truncated}, datasets, key, index,
                        lambda d: (d["shape"], d["dtype"], hdus[int(d["key"])].section.__getitem__))
        result["arrays"] = [describe(d, result.get("plot") if d["key"] == result["selected"] else None) for d in datasets]
        return result


DISPATCH = {"h5": summarize_hdf5, "hdf5": summarize_hdf5, "parquet": summarize_parquet,
            "npy": summarize_npy, "npz": summarize_npz, "nc": summarize_netcdf, "nc4": summarize_netcdf, "cdf": summarize_netcdf,
            "mat": summarize_mat, "mtx": summarize_mtx, "fits": summarize_fits, "fit": summarize_fits, "fts": summarize_fits}


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "summarize":
        sys.stderr.write("usage: arrays_helper.py summarize <path> [key] [slice]\n")
        sys.exit(5)
    path = Path(sys.argv[2])
    if not path.is_file():
        sys.stderr.write("File not found\n")
        sys.exit(4)
    try:
        ext = path.suffix.lower().lstrip(".")
        if ext not in DISPATCH:
            raise ValueError(f"Unsupported extension: {ext}")
        index = int(sys.argv[4]) if len(sys.argv) > 4 else 0
        if index < 0:
            raise ValueError("Slice must be nonnegative")
        result = DISPATCH[ext](path, sys.argv[3] if len(sys.argv) > 3 else "", index)
        result["file_size"] = path.stat().st_size
        sys.stdout.write(json.dumps(result, allow_nan=False))
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(5)


if __name__ == "__main__":
    main()
