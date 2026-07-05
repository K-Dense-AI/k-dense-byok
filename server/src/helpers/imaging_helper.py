"""DICOM / NIfTI / TIFF bio-imaging preview helper. Shelled out to by the TS backend.

Usage:
  python imaging_helper.py summarize <path>                    -> JSON to stdout
  python imaging_helper.py render <path> <index> <out> <axis>  -> writes a PNG to <out>
    `axis` selects the NIfTI plane (sagittal|coronal|axial); DICOM/TIFF ignore it
    ("-") and `index` selects the frame/page instead.

Exit codes: 0 ok; 3 deps missing; 4 not found (or index out of range); 5 bad
value (unsupported extension / unparsable file / bad axis); 1 other.

DICOM PHI note: `summarize`'s `meta` is built from an explicit whitelist of
technical/enumerated tags only (Modality, Rows, Columns, ...). It must never
surface PatientName/PatientID/PatientBirthDate or any other free-text/name
tag — this is a hard security requirement, not a style preference.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

MAX_PNG_SIDE = 1024

# PHI-safe whitelist: technical/enumerated DICOM tags only. Never add a
# free-text or patient-identifying tag (PatientName, PatientID, ReferringPhysicianName,
# InstitutionName, SeriesDescription, StudyDescription, ...) to this list.
_DICOM_META_WHITELIST = [
    "Modality",
    "Rows",
    "Columns",
    "BitsAllocated",
    "BitsStored",
    "PixelRepresentation",
    "SamplesPerPixel",
    "PhotometricInterpretation",
    "PixelSpacing",
    "SliceThickness",
    "WindowCenter",
    "WindowWidth",
]


def _need(module_name: str, pip_name: str | None = None) -> None:
    try:
        __import__(module_name)
    except ImportError as exc:
        sys.stderr.write(f"{pip_name or module_name} not installed: {exc}\n")
        sys.exit(3)


def _detect_format(path: Path) -> str:
    name = path.name.lower()
    if name.endswith(".nii.gz") or name.endswith(".nii"):
        return "nifti"
    if name.endswith(".dcm") or name.endswith(".dicom"):
        return "dicom"
    if name.endswith(".ome.tif") or name.endswith(".ome.tiff") or name.endswith(".tif") or name.endswith(".tiff"):
        return "tiff"
    sys.stderr.write(f"Unsupported extension: {path.suffix}\n")
    sys.exit(5)


def _jsonify(value):
    """Recursively coerce pydicom value-representation types into plain JSON types."""
    from pydicom.multival import MultiValue

    if isinstance(value, MultiValue) or isinstance(value, (list, tuple)):
        return [_jsonify(v) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    return str(value)


def _to_png(arr, out: Path, value_range: tuple[float, float] | None = None, cap: int = MAX_PNG_SIDE) -> None:
    """Normalize a 2D (or channel-first/last) array to uint8 grayscale and write a PNG.

    `value_range`, if given, is an explicit (lo, hi) to normalize against (e.g. a DICOM
    window); otherwise falls back to the array's own min/max.
    """
    _need("numpy")
    _need("PIL", "pillow")
    import numpy as np
    from PIL import Image

    arr = np.asarray(arr)
    if arr.ndim > 2:
        # Collapse an extra channel/sample dimension: prefer a trailing dim of
        # <=4 (channel-last), else fall back to the leading dim (channel-first).
        if arr.shape[-1] <= 4:
            arr = arr[..., 0]
        else:
            arr = arr[0]
    if arr.ndim != 2:
        sys.stderr.write(f"Cannot render a {arr.ndim}D slice as an image\n")
        sys.exit(5)

    arr = arr.astype(np.float64)
    if value_range is not None:
        lo, hi = value_range
    else:
        lo = float(np.nanmin(arr)) if arr.size else 0.0
        hi = float(np.nanmax(arr)) if arr.size else 0.0
    if hi > lo:
        norm = (arr - lo) / (hi - lo)
    else:
        norm = np.zeros_like(arr)
    u8 = (np.clip(norm, 0.0, 1.0) * 255).astype(np.uint8)

    img = Image.fromarray(u8, mode="L")
    longest = max(img.size)
    if longest > cap:
        scale = cap / longest
        new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        img = img.resize(new_size, Image.Resampling.BILINEAR)
    img.save(out, format="PNG")


# --- NIfTI -------------------------------------------------------------------

_NIFTI_AXES = {"sagittal": 0, "coronal": 1, "axial": 2}


def _load_nifti(path: Path):
    _need("nibabel")
    _need("numpy")
    import nibabel as nib

    try:
        img = nib.load(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Failed to load NIfTI: {exc}\n")
        sys.exit(5)
    shape = img.header.get_data_shape()
    if len(shape) < 3:
        sys.stderr.write("NIfTI volume has fewer than 3 spatial dimensions\n")
        sys.exit(5)
    return img, shape


def summarize_nifti(path: Path) -> dict:
    img, shape = _load_nifti(path)
    header = img.header
    zooms = header.get_zooms()
    affine = img.affine

    meta: dict = {
        "voxel_sizes": [float(z) for z in zooms[:3]],
        "affine_diagonal": [float(affine[i][i]) for i in range(3)],
    }
    intent = header.get_intent()
    if intent and intent[0] and intent[0] != "none":
        meta["intent"] = str(intent[0])

    return {
        "format": "nifti",
        "file_size": path.stat().st_size,
        "shape": [int(s) for s in shape],
        "dtype": str(header.get_data_dtype()),
        "axes": [
            {"name": "sagittal", "size": int(shape[0])},
            {"name": "coronal", "size": int(shape[1])},
            {"name": "axial", "size": int(shape[2])},
        ],
        "default_axis": "axial",
        "meta": meta,
    }


def render_nifti(path: Path, index: int, out: Path, axis: str) -> None:
    _need("numpy")
    _need("nibabel")
    import numpy as np

    img, shape = _load_nifti(path)
    if axis not in _NIFTI_AXES:
        sys.stderr.write(f"Invalid axis: {axis}\n")
        sys.exit(5)
    ax = _NIFTI_AXES[axis]
    size = shape[ax]
    if index < 0 or index >= size:
        sys.stderr.write(f"Slice index out of range: {index}\n")
        sys.exit(4)

    data = img.dataobj
    idx: list = []
    for d in range(len(shape)):
        if d == ax:
            idx.append(index)
        elif d < 3:
            idx.append(slice(None))
        else:
            idx.append(0)  # collapse any non-spatial (e.g. time) dimension
    arr = np.asarray(data[tuple(idx)])
    _to_png(arr, out)


# --- DICOM ---------------------------------------------------------------


def _load_dicom(path: Path):
    _need("pydicom")
    import pydicom

    try:
        return pydicom.dcmread(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Failed to read DICOM: {exc}\n")
        sys.exit(5)


def summarize_dicom(path: Path) -> dict:
    ds = _load_dicom(path)
    rows = int(getattr(ds, "Rows", 0) or 0)
    cols = int(getattr(ds, "Columns", 0) or 0)
    n_frames = int(getattr(ds, "NumberOfFrames", 1) or 1)

    meta: dict = {}
    for tag in _DICOM_META_WHITELIST:
        if hasattr(ds, tag):
            meta[tag] = _jsonify(getattr(ds, tag))
    meta["NumberOfFrames"] = n_frames

    bits_allocated = int(getattr(ds, "BitsAllocated", 8) or 8)
    pixel_repr = int(getattr(ds, "PixelRepresentation", 0) or 0)
    if bits_allocated <= 8:
        dtype = "uint8"
    elif bits_allocated <= 16:
        dtype = "int16" if pixel_repr == 1 else "uint16"
    else:
        dtype = "int32" if pixel_repr == 1 else "uint32"

    return {
        "format": "dicom",
        "file_size": path.stat().st_size,
        "shape": [n_frames, rows, cols] if n_frames > 1 else [rows, cols],
        "dtype": dtype,
        "axes": [{"name": "frame", "size": n_frames}],
        "default_axis": "frame",
        "meta": meta,
    }


def render_dicom(path: Path, index: int, out: Path) -> None:
    _need("numpy")
    _need("pydicom")
    import numpy as np
    import pydicom
    from pydicom.multival import MultiValue

    ds = _load_dicom(path)
    if "PixelData" not in ds:
        sys.stderr.write("DICOM file has no pixel data\n")
        sys.exit(5)

    n_frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    if index < 0 or index >= n_frames:
        sys.stderr.write(f"Frame index out of range: {index}\n")
        sys.exit(4)

    try:
        pixels = ds.pixel_array
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Failed to decode pixel data: {exc}\n")
        sys.exit(5)

    frame = pixels[index] if n_frames > 1 else pixels
    frame = frame.astype(np.float64)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    frame = frame * slope + intercept

    value_range = None
    wc = getattr(ds, "WindowCenter", None)
    ww = getattr(ds, "WindowWidth", None)
    if wc is not None and ww is not None:
        wc_v = float(wc[0]) if isinstance(wc, MultiValue) else float(wc)
        ww_v = float(ww[0]) if isinstance(ww, MultiValue) else float(ww)
        value_range = (wc_v - ww_v / 2, wc_v + ww_v / 2)

    _to_png(frame, out, value_range=value_range)


# --- TIFF ------------------------------------------------------------------


def _tiff_stack(tif):
    """Return (num_slices, series) for a TiffFile, treating the leading non-spatial
    axis (real pages, or samples/depth packed into a single IFD) as the stack axis."""
    series = tif.series[0] if tif.series else None
    if series is None:
        return len(tif.pages), None
    shape = series.shape
    if len(shape) <= 2:
        return 1, series
    return shape[0], series


def summarize_tiff(path: Path) -> dict:
    _need("tifffile")
    import tifffile

    try:
        tif = tifffile.TiffFile(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Failed to read TIFF: {exc}\n")
        sys.exit(5)
    try:
        n_slices, series = _tiff_stack(tif)
        first_page = tif.pages[0]
        shape = list(series.shape) if series is not None else list(first_page.shape)
        dtype = str(series.dtype) if series is not None else str(first_page.dtype)
        photometric = getattr(first_page.photometric, "name", str(first_page.photometric))
        meta: dict = {
            "shape": shape,
            "dtype": dtype,
            "photometric": str(photometric),
            "n_pages": n_slices,
        }
        if series is not None:
            meta["axes"] = series.axes
        if getattr(tif, "is_ome", False):
            meta["ome_axes"] = series.axes if series is not None else None
    finally:
        tif.close()

    return {
        "format": "tiff",
        "file_size": path.stat().st_size,
        "shape": shape,
        "dtype": dtype,
        "axes": [{"name": "page", "size": n_slices}],
        "default_axis": "page",
        "meta": meta,
    }


def render_tiff(path: Path, index: int, out: Path) -> None:
    _need("tifffile")
    import tifffile

    try:
        tif = tifffile.TiffFile(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Failed to read TIFF: {exc}\n")
        sys.exit(5)
    try:
        n_slices, _series = _tiff_stack(tif)
        if index < 0 or index >= n_slices:
            sys.stderr.write(f"Page index out of range: {index}\n")
            sys.exit(4)
        full = tif.asarray()
    finally:
        tif.close()

    arr = full[index] if full.ndim > 2 else full
    _to_png(arr, out)


_SUMMARIZE = {"nifti": summarize_nifti, "dicom": summarize_dicom, "tiff": summarize_tiff}


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: imaging_helper.py <summarize|render> <path> [...]\n")
        sys.exit(1)
    cmd, raw_path = sys.argv[1], Path(sys.argv[2])
    if not raw_path.exists():
        sys.stderr.write(f"File not found: {raw_path}\n")
        sys.exit(4)
    fmt = _detect_format(raw_path)

    try:
        if cmd == "summarize":
            sys.stdout.write(json.dumps(_SUMMARIZE[fmt](raw_path)))
        elif cmd == "render":
            if len(sys.argv) < 6:
                sys.stderr.write("usage: imaging_helper.py render <path> <index> <out> <axis>\n")
                sys.exit(1)
            try:
                index = int(sys.argv[3])
            except ValueError:
                sys.stderr.write(f"Invalid index: {sys.argv[3]}\n")
                sys.exit(5)
            out_path = Path(sys.argv[4])
            axis = sys.argv[5]
            if fmt == "nifti":
                render_nifti(raw_path, index, out_path, axis)
            elif fmt == "dicom":
                render_dicom(raw_path, index, out_path)
            else:
                render_tiff(raw_path, index, out_path)
        else:
            sys.stderr.write(f"unknown command: {cmd}\n")
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
