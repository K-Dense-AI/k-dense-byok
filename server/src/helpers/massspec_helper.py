"""Mass-spec (mzML/mzXML/MGF) + JCAMP-DX preview helper.

Usage: python massspec_helper.py summarize <path>  -> JSON to stdout
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json, math, re, sys
from decimal import Decimal
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
    """Decode a single AFFN table, refusing unsupported encodings as a whole.

    JCAMP-DX 4.24 sections 5.1.1 and 6.2.5 define the implicit X interval and
    scaling: https://iupac.org/wp-content/uploads/2021/08/JCAMP-DX_IR_1988.pdf
    DELTAX is only a nominal interval, not the source for reconstructed Xs.
    """
    text = path.read_text(errors="replace")
    meta, rows, in_data, mode = {}, [], False, None
    number = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?\Z")
    for raw in text.splitlines():
        line = raw.split("$$", 1)[0].strip()
        if not line:
            continue
        if line.startswith("##"):
            key, _, val = line[2:].partition("=")
            key, val = re.sub(r"[\s_-]", "", key.upper()), val.strip()
            if (key == "TITLE" and key in meta) or key in ("NTUPLES", "DATATABLE", "PAGE") or (key == "DATATYPE" and val.upper() == "LINK"):
                raise ValueError("Compound and NTUPLES JCAMP encodings are not supported by the preview")
            meta[key] = val
            in_data = key in ("XYDATA", "XYPOINTS", "PEAKTABLE")
            if in_data:
                if mode is not None:
                    raise ValueError("Multiple JCAMP data tables are not supported by the preview")
                mode = re.sub(r"\s", "", val.upper())
                if mode not in ("(X++(Y..Y))", "(XY..XY)") or (mode == "(X++(Y..Y))" and key != "XYDATA"):
                    raise ValueError("Unsupported JCAMP table encoding; use numeric X++ or XY pairs")
            continue
        if in_data:
            tokens = [t for t in re.split(r"[\s,;]+", line) if t]
            if not tokens or any(not number.fullmatch(t) for t in tokens):
                raise ValueError("Compressed or invalid JCAMP data is unsupported; use plain numeric (AFFN) data")
            vals = [float(t) for t in tokens]
            if not all(math.isfinite(v) for v in vals):
                raise ValueError("JCAMP data values must be finite")
            if len(vals) < 2 or (mode == "(XY..XY)" and len(vals) % 2):
                raise ValueError("Incomplete JCAMP data row")
            # Preserve the written checkpoint precision before float parsing
            # loses trailing zeroes/exponents. An integer checkpoint may be
            # rounded much more coarsely than the actual sample interval.
            precision = Decimal(tokens[0]).as_tuple().exponent
            rows.append((vals, 10.0 ** min(308, precision)))

    def parameter(name, default=None):
        raw = meta.get(name)
        if raw is None:
            if default is not None:
                return default
            raise ValueError(f"JCAMP {name} is required for implicit X values")
        if not number.fullmatch(raw):
            raise ValueError(f"Invalid JCAMP {name}")
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(f"JCAMP {name} must be finite")
        return value

    xs, ys = [], []
    xfactor, yfactor = parameter("XFACTOR", 1.0), parameter("YFACTOR", 1.0)
    count = parameter("NPOINTS") if "NPOINTS" in meta or mode == "(X++(Y..Y))" else None
    if count is not None and (count < 1 or not count.is_integer()):
        raise ValueError("JCAMP NPOINTS must be a positive integer")
    if mode == "(X++(Y..Y))":
        first, last = parameter("FIRSTX"), parameter("LASTX")
        if count == 1 and first != last:
            raise ValueError("Single-point JCAMP endpoints must agree")
        delta = (last - first) / (count - 1) if count > 1 else 0.0
        for row, quantum in rows:
            expected_start = first + len(ys) * delta
            # Row checkpoints may be rounded, while FIRSTX/LASTX preserve the
            # interval's precision. Allow half the last written decimal unit,
            # scaled into actual X units, plus float arithmetic rounding. The
            # spec's X-sequence check (5.8.1) must not impose an arbitrary
            # fraction-of-interval precision requirement on valid checkpoints.
            actual_start = row[0] * xfactor
            rounding = max(abs(xfactor) * quantum / 2, 8 * max(math.ulp(actual_start), math.ulp(expected_start)))
            if not math.isclose(actual_start, expected_start, rel_tol=0, abs_tol=rounding):
                raise ValueError("JCAMP row X value disagrees with its declared interval")
            for y in row[1:]:
                xs.append(first + len(ys) * delta)
                ys.append(y * yfactor)
    else:
        for row, _ in rows:
            for i in range(0, len(row), 2):
                xs.append(row[i] * xfactor)
                ys.append(row[i + 1] * yfactor)
    if not xs:
        raise ValueError("No JCAMP data points parsed")
    if count is not None and len(xs) != count:
        raise ValueError("JCAMP data count does not match NPOINTS")
    if not all(math.isfinite(v) for v in xs + ys):
        raise ValueError("Scaled JCAMP values must be finite")
    cx, cy = _downsample_xy(xs, ys, MAX_CHROM)
    return {"format": "jcamp", "mode": "curve", "title": meta.get("TITLE", path.stem),
            "n_spectra": 1, "x_label": meta.get("XUNITS", "x"), "y_label": meta.get("YUNITS", "y"),
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
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n"); sys.exit(5)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n"); sys.exit(1)


if __name__ == "__main__":
    main()
