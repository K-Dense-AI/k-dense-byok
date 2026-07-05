"""Mass-spec (mzML/mzXML/MGF) + JCAMP-DX preview helper.

Usage: python massspec_helper.py summarize <path>  -> JSON to stdout
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

MAX_SPECTRA = 25
MAX_PEAKS = 2000
MAX_CHROM = 3000


def _downsample_xy(xs, ys, cap):
    n = len(xs)
    if n <= cap:
        return list(map(float, xs)), list(map(float, ys))
    step = (n + cap - 1) // cap
    return [float(xs[i]) for i in range(0, n, step)], [float(ys[i]) for i in range(0, n, step)]


def _top_peaks(mz, inten, cap):
    pairs = list(zip(mz, inten))
    if len(pairs) > cap:
        pairs = sorted(pairs, key=lambda p: p[1], reverse=True)[:cap]
    pairs.sort(key=lambda p: p[0])
    return [float(m) for m, _ in pairs], [float(i) for _, i in pairs]


def _need_pyteomics():
    try:
        import pyteomics  # noqa: F401
    except ImportError as exc:
        sys.stderr.write(f"pyteomics not installed: {exc}\n"); sys.exit(3)


def _precursor_mz(s: dict):
    """Best-effort precursor m/z extraction across the mzML/mzXML dict shapes."""
    try:
        pre = s["precursorList"]["precursor"][0]
        ion = pre["selectedIonList"]["selectedIon"][0]
        return float(ion["selected ion m/z"])
    except Exception:
        pass
    try:
        pmz = s.get("precursorMz")
        if pmz:
            return float(pmz[0]["precursorMz"])
    except Exception:
        pass
    return None


def summarize_mgf(path: Path) -> dict:
    _need_pyteomics()
    from pyteomics import mgf
    spectra, total = [], 0
    with mgf.read(str(path)) as reader:
        for s in reader:
            total += 1
            if len(spectra) < MAX_SPECTRA:
                mz, inten = _top_peaks(list(s["m/z array"]), list(s["intensity array"]), MAX_PEAKS)
                params = s.get("params", {})
                pep = params.get("pepmass")
                spectra.append({
                    "id": str(params.get("title", f"spectrum {total}")),
                    "ms_level": 2, "rt": None,
                    "precursor_mz": float(pep[0]) if pep else None,
                    "mz": mz, "intensity": inten,
                })
    return {"format": "mgf", "mode": "spectra", "title": path.stem, "n_spectra": total,
            "x_label": "m/z", "y_label": "intensity", "chromatogram": None,
            "spectra": spectra, "curve": None}


def summarize_msrun(path: Path, fmt: str) -> dict:
    _need_pyteomics()
    if fmt == "mzml":
        from pyteomics import mzml as reader_mod
    else:
        from pyteomics import mzxml as reader_mod
    chrom_x, chrom_y, spectra, total = [], [], [], 0
    with reader_mod.read(str(path)) as reader:
        for s in reader:
            total += 1
            level = s.get("ms level", s.get("msLevel"))
            # retention time (mzml nests it under scanList; mzxml is flat)
            rt = None
            try:
                rt = float(s["scanList"]["scan"][0]["scan start time"])
            except Exception:
                rt = float(s.get("retentionTime")) if s.get("retentionTime") is not None else None
            mz_arr, in_arr = list(s.get("m/z array", [])), list(s.get("intensity array", []))
            if level == 1 and rt is not None:
                tic = s.get("total ion current", s.get("totIonCurrent"))
                chrom_x.append(rt)
                chrom_y.append(float(tic) if tic is not None else (sum(in_arr) if in_arr else 0.0))
            if len(spectra) < MAX_SPECTRA and mz_arr:
                mz, inten = _top_peaks(mz_arr, in_arr, MAX_PEAKS)
                spectra.append({"id": str(s.get("id", f"scan {total}")), "ms_level": int(level) if level else None,
                                "rt": rt, "precursor_mz": _precursor_mz(s) if level and level > 1 else None,
                                "mz": mz, "intensity": inten})
    cx, cy = _downsample_xy(chrom_x, chrom_y, MAX_CHROM) if chrom_x else ([], [])
    return {"format": fmt, "mode": "chromatogram+spectra", "title": path.stem, "n_spectra": total,
            "x_label": "m/z", "y_label": "intensity",
            "chromatogram": {"x": cx, "y": cy} if cx else None, "spectra": spectra, "curve": None}


def summarize_jcamp(path: Path) -> dict:
    text = path.read_text(errors="replace")
    meta, xs, ys, in_data = {}, [], [], False
    x_label, y_label = "x", "y"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("##"):
            key, _, val = line[2:].partition("=")
            key, val = key.strip().upper(), val.strip()
            meta[key] = val
            if key == "XUNITS": x_label = val
            if key == "YUNITS": y_label = val
            in_data = key in ("XYDATA", "XYPOINTS", "PEAK TABLE", "DATA TABLE")
            continue
        if in_data:
            nums = [t for t in line.replace(",", " ").split() if t]
            try:
                vals = [float(t) for t in nums]
            except ValueError:
                continue
            # (XY..XY): alternating x y pairs; also handle (X++(Y..Y)) rows: first is X, rest are Y
            if meta.get("XYDATA", "").upper().startswith("(X++"):
                x0 = vals[0]
                for k, y in enumerate(vals[1:]):
                    xs.append(x0 + k); ys.append(y)  # index-based x when only Y given
            else:
                for i in range(0, len(vals) - 1, 2):
                    xs.append(vals[i]); ys.append(vals[i + 1])
    if not xs:
        sys.stderr.write("No JCAMP data points parsed\n"); sys.exit(5)
    cx, cy = _downsample_xy(xs, ys, MAX_CHROM)
    return {"format": "jcamp", "mode": "curve", "title": meta.get("TITLE", path.stem),
            "n_spectra": 1, "x_label": x_label, "y_label": y_label,
            "chromatogram": None, "spectra": [], "curve": {"x": cx, "y": cy}}


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] != "summarize":
        sys.stderr.write("usage: massspec_helper.py summarize <path>\n"); sys.exit(1)
    p = Path(sys.argv[2])
    if not p.exists():
        sys.stderr.write(f"File not found: {p}\n"); sys.exit(4)
    ext = p.suffix.lower().lstrip(".")
    try:
        if ext == "mgf": data = summarize_mgf(p)
        elif ext in ("jdx", "dx"): data = summarize_jcamp(p)
        elif ext in ("mzml", "mzxml"): data = summarize_msrun(p, ext)
        else:
            sys.stderr.write(f"Unsupported extension: {ext}\n"); sys.exit(5)
        sys.stdout.write(json.dumps(data))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n"); sys.exit(1)


if __name__ == "__main__":
    main()
