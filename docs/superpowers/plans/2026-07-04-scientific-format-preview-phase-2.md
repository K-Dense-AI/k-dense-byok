# Scientific Format Preview — Phase 2 (Mass Spec & Spectroscopy) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render mass-spectrometry runs and spectra (mzML/mzXML/MGF) and JCAMP-DX spectroscopy (NMR/IR) in the preview panel — parsed by a Python helper, plotted client-side with chart.js.

**Architecture:** Plan 2 of the phased spec. Reuses the Phase-0 foundation unchanged: a `massspec_helper.py` decoder invoked through the generic `sci-summary` endpoint (`kind="massspec"`), returning bounded/downsampled JSON, rendered by a lazy-loaded `SpectrumViewer` using chart.js (already a dependency, loaded via `import("chart.js/auto")` — see `web/src/components/interview-form.tsx` for the existing pattern).

**Tech Stack:** Fastify+tsx backend, Next.js/React/TS frontend, vitest, uv-managed Python (`pyteomics`, `lxml`), chart.js.

## Global Constraints

- Both services run via `tsx`; never `tsc` for emit. `npx tsc --noEmit` must stay clean for `web/`.
- Python helper deps live ONLY in `server/src/helpers/pyproject.toml` (uv-managed helper venv); after adding deps run `cd server/src/helpers && uv sync`.
- Helper CLI exit-code contract (verbatim): `0` ok, `3` deps missing, `4` not found, `5` bad value, `1` other. JSON summary to stdout.
- The registry is ADDITIVE — do not modify existing viewers. New viewers are view-only (`canEditSource: false`).
- New viewers use `loadMode: "none"` (they fetch their own summary from the endpoint) unless they need the raw text.
- Deps-gated Python tests use `it.runIf(depsOk)` with a `15000` ms timeout (cold-start of the venv python is slow — established in Phase 1).
- Bound all payloads: never stream raw multi-MB peak arrays to the browser (downsample; cap spectra count).
- Company name is "K-Dense" (not "K-Dense AI") in user-facing copy.

## File Structure

- Create: `server/src/helpers/massspec_helper.py` — mzML/mzXML/MGF via pyteomics + a self-contained JCAMP-DX parser; `summarize` subcommand only.
- Create: `web/src/components/viewers/spectrum-viewer.tsx` — chart.js TIC/peak/curve plots (default export).
- Create: `server/test/massspec-helper.test.ts`, `web/src/components/viewers/spectrum-viewer.test.tsx`.
- Create fixtures: `server/test/fixtures/sample.mgf`, `server/test/fixtures/sample.jdx` (hand-authored). mzML/mzXML fixtures: see Task 2 Step 1.
- Modify: `web/src/lib/use-sandbox.ts` (`FileCategory` + `fileCategory` + `MASSSPEC_EXTS`), `web/src/components/file-preview-panel.tsx` (`categoryLabel`), `web/src/components/file-icon.tsx` (icon), `server/src/sandbox-fs.ts` (MIME), `server/src/helpers/pyproject.toml` (deps), `server/src/api/sci-helpers.ts` (`SciKind` + `KIND_TO_SCRIPT`), `web/src/lib/viewers/registry.ts` (register `massspec`).

---

### Task 1: Phase-2 foundation (classification, deps, dispatcher)

**Files:**
- Modify: `web/src/lib/use-sandbox.ts` — add `"massspec"` to `FileCategory`; `const MASSSPEC_EXTS = new Set(["mzml","mzxml","mgf","jdx","dx"]);`; classify in `fileCategory` (after the structure3d check).
- Modify: `web/src/components/file-preview-panel.tsx` `categoryLabel` — `if (cat === "massspec") return ext === "jdx" || ext === "dx" ? "spectrum" : ext;`
- Modify: `web/src/components/file-icon.tsx` — add to the existing lucide import `WavesIcon`; `if (cat === "massspec") return <WavesIcon className={\`${className} text-teal-500\`} />;`
- Modify: `server/src/sandbox-fs.ts` MIME map — `".mzml": "application/xml", ".mzxml": "application/xml", ".mgf": "text/plain", ".jdx": "chemical/x-jcamp-dx", ".dx": "chemical/x-jcamp-dx"`.
- Modify: `server/src/helpers/pyproject.toml` — add `"pyteomics"` and `"lxml"` to `dependencies`.
- Modify: `server/src/api/sci-helpers.ts` — extend `SciKind` to `"chem" | "structure" | "massspec"` and add `massspec: "massspec_helper.py"` to `KIND_TO_SCRIPT`.
- Test: extend `web/src/lib/use-sandbox.test.ts` and `server/test/backend.test.ts`.

**Interfaces:**
- Produces: `fileCategory` returns `"massspec"` for mzml/mzxml/mgf/jdx/dx; `sciHelperFor("massspec")?.script` ends with `massspec_helper.py`.

- [ ] **Step 1: Failing tests**

```ts
// add to web/src/lib/use-sandbox.test.ts
describe("fileCategory — mass spec", () => {
  it("classifies mass-spec & spectroscopy formats", () => {
    for (const n of ["a.mzml", "a.mzxml", "a.mgf", "a.jdx", "a.dx"]) {
      expect(fileCategory(n)).toBe("massspec");
    }
  });
});
```
```ts
// add to server/test/backend.test.ts (near the sci helper dispatch describe)
it("resolves the massspec kind", () => {
  expect(sciHelperFor("massspec")?.script.endsWith("massspec_helper.py")).toBe(true);
});
// and extend the guessMime test:
expect(guessMime("a.mzml")).toBe("application/xml");
expect(guessMime("a.jdx")).toBe("chemical/x-jcamp-dx");
```

- [ ] **Step 2: Run — expect FAIL** (`cd web && npx vitest run src/lib/use-sandbox.test.ts` ; `cd server && npx vitest run test/backend.test.ts -t "massspec"`).

- [ ] **Step 3: Implement** the modifications listed under Files. In `fileCategory`, add `if (MASSSPEC_EXTS.has(ext)) return "massspec";` after the `STRUCTURE3D_EXTS` check.

- [ ] **Step 4: Run — expect PASS**; then `cd server/src/helpers && uv sync` (installs pyteomics+lxml); then `cd web && npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit** `feat(sci): classify mass-spec/spectroscopy formats + massspec dispatcher`

---

### Task 2: massspec_helper.py

**Files:**
- Create: `server/src/helpers/massspec_helper.py`
- Create fixtures: `server/test/fixtures/sample.mgf`, `server/test/fixtures/sample.jdx`
- Test: `server/test/massspec-helper.test.ts`

**Interfaces:**
- Produces CLI `massspec_helper.py summarize <path>` → JSON:
  ```
  { format, mode, title, n_spectra, x_label, y_label,
    chromatogram: {x:[num], y:[num]} | null,
    spectra: [ {id, ms_level, rt, precursor_mz, mz:[num], intensity:[num]} ],
    curve: {x:[num], y:[num]} | null }
  ```
  Caps: ≤25 spectra returned (each ≤2000 peaks, kept by highest intensity, then re-sorted by m/z); chromatogram ≤3000 points; `n_spectra` is the true total. Exit-code contract as in Global Constraints.

- [ ] **Step 1: Write failing test + fixtures**

Fixtures (hand-authored, robust):

`server/test/fixtures/sample.mgf`:
```
BEGIN IONS
TITLE=spectrum 1
PEPMASS=445.12
CHARGE=2+
100.0 200.0
150.5 999.0
200.2 350.0
END IONS
BEGIN IONS
TITLE=spectrum 2
PEPMASS=560.30
110.0 50.0
300.0 800.0
END IONS
```

`server/test/fixtures/sample.jdx` (minimal JCAMP-DX, (XY..XY) form):
```
##TITLE=Test IR
##JCAMP-DX=4.24
##DATA TYPE=INFRARED SPECTRUM
##XUNITS=1/CM
##YUNITS=TRANSMITTANCE
##XYDATA=(XY..XY)
4000 0.95
3000 0.80
2000 0.60
1000 0.20
##END=
```

mzML/mzXML fixtures: fetch one small real file each into `server/test/fixtures/` (network is available in dev). Suggested: a tiny public example (e.g. the ProteoWizard/pyteomics "tiny" example mzML, ~30KB). Run:
```bash
curl -sSL -o server/test/fixtures/sample.mzml "<a small public mzML URL>"
```
If no reliable URL is found, generate a minimal valid mzML with `psims` in a throwaway `uvx --with psims python` one-liner, OR skip committing mzml/mzxml fixtures and gate their tests on file existence (`it.runIf(depsOk && fs.existsSync(mzmlPath))`). Whichever path you take, **log in your report which formats have committed fixtures** — do not silently drop mzML coverage.

```ts
// server/test/massspec-helper.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk = spawnSync(helperPython(), ["-c", "import pyteomics"], { stdio: "ignore" }).status === 0;

describe("massspec_helper", () => {
  it.runIf(depsOk)("summarizes an MGF peak list", () => {
    const res = runSciHelper("massspec", "summarize", [path.join(FIX, "sample.mgf")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("mgf");
    expect(d.n_spectra).toBe(2);
    expect(d.spectra[0].mz.length).toBe(3);
    expect(d.spectra[0].intensity.length).toBe(3);
  }, 15000);

  it("summarizes a JCAMP-DX curve (no pyteomics needed)", () => {
    const res = runSciHelper("massspec", "summarize", [path.join(FIX, "sample.jdx")]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    expect(d.format).toBe("jcamp");
    expect(d.curve.x.length).toBe(4);
    expect(d.x_label.toLowerCase()).toContain("cm"); // XUNITS=1/CM
  }, 15000);

  it("exits 4 on a missing file", () => {
    expect(runSciHelper("massspec", "summarize", [path.join(FIX, "nope.mgf")]).status).toBe(4);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (helper missing): `cd server && npx vitest run test/massspec-helper.test.ts`

- [ ] **Step 3: Implement `server/src/helpers/massspec_helper.py`**

```python
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
    step = n // cap
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
                chrom_x.append(rt); chrom_y.append(float(s.get("total ion current", sum(in_arr) if in_arr else 0.0)))
            if len(spectra) < MAX_SPECTRA and mz_arr:
                mz, inten = _top_peaks(mz_arr, in_arr, MAX_PEAKS)
                spectra.append({"id": str(s.get("id", f"scan {total}")), "ms_level": int(level) if level else None,
                                "rt": rt, "precursor_mz": None, "mz": mz, "intensity": inten})
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
```

- [ ] **Step 4: Run — expect PASS** (`cd server && npx vitest run test/massspec-helper.test.ts`). MGF + JCAMP tests must pass; report mzML/mzXML fixture status.

- [ ] **Step 5: Commit** `feat(helpers): massspec_helper for mzML/mzXML/MGF/JCAMP`

---

### Task 3: SpectrumViewer (chart.js) + register massspec

**Files:**
- Create: `web/src/components/viewers/spectrum-viewer.tsx` (default export)
- Modify: `web/src/lib/viewers/registry.ts` — register `massspec: { loadMode: "none", Viewer: SpectrumViewer, canEditSource: false, managesOwnScroll: true }`.
- Test: `web/src/components/viewers/spectrum-viewer.test.tsx`

**Interfaces:**
- Consumes: `sciSummaryUrl(path, "massspec")`, `ViewerProps`. chart.js via `import("chart.js/auto")`.
- Produces: default-exported `SpectrumViewer`; renders a header (format, n_spectra), a TIC line chart when `chromatogram` present, a spectrum `<select>` + stem/bar chart of the chosen spectrum's peaks, or a curve line chart for JCAMP. Uses a `<canvas>` + a chart.js instance created in `useEffect`, destroyed on cleanup/redraw. Deps-missing (503) and error states show a friendly message.

- [ ] **Step 1: Failing test**

```tsx
// web/src/components/viewers/spectrum-viewer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SpectrumViewer from "./spectrum-viewer";

vi.mock("chart.js/auto", () => ({ default: class { constructor(){} update(){} destroy(){} } }));

const summary = {
  format: "mgf", mode: "spectra", title: "t", n_spectra: 2, x_label: "m/z", y_label: "intensity",
  chromatogram: null,
  spectra: [{ id: "spectrum 1", ms_level: 2, rt: null, precursor_mz: 445.1, mz: [100, 150], intensity: [200, 999] }],
  curve: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } })));
});

describe("SpectrumViewer", () => {
  it("renders header + spectrum info from the summary", async () => {
    render(<SpectrumViewer path="a.mgf" name="a.mgf" content={null} />);
    await waitFor(() => expect(screen.getByText(/2 spectra/i)).toBeInTheDocument());
    expect(screen.getByText(/spectrum 1/i)).toBeInTheDocument();
  });
  it("shows a friendly message on a 503 deps-missing response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "pyteomics not installed" }), { status: 503 })));
    render(<SpectrumViewer path="a.mzml" name="a.mzml" content={null} />);
    await waitFor(() => expect(screen.getByText(/unavailable|not installed/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `spectrum-viewer.tsx`.** Fetch the summary from `sciSummaryUrl(path, "massspec")`; on error/503 show a friendly card. Render: a header line `{n_spectra} spectra · {format}`; if `chromatogram`, a chart.js `line` chart (x=chromatogram.x, y=chromatogram.y, labels from `x_label`/`y_label` — TIC uses "retention time"/"intensity"); a `<select>` listing `spectra[].id` (shown when `spectra.length`); the selected spectrum drawn as a `bar` chart (m/z vs intensity, thin bars = stems); if `curve`, a `line` chart of curve.x/curve.y with `x_label`/`y_label`. Create the chart.js instance in a `useEffect` keyed on the current data, and `chart.destroy()` on cleanup (chart.js leaks canvases otherwise). Follow the `import("chart.js/auto")` dynamic-import pattern from `web/src/components/interview-form.tsx`. Guard against post-unmount updates (an `alive`/`disposed` flag). Register `massspec` in `registry.ts`.

- [ ] **Step 4: Run — expect PASS** (`cd web && npx vitest run src/components/viewers/spectrum-viewer.test.tsx`) and `npx tsc --noEmit` clean and full suite adds no new failures beyond the ~18 pre-existing.

- [ ] **Step 5: Commit** `feat(viewers): mass-spec / spectroscopy viewer (mzML/MGF/JCAMP via chart.js)`

---

## Manual verification
Start the app, upload `sample.mgf` and `sample.jdx` (and a real `.mzml` fetched during dev) → confirm: MGF shows a spectrum selector + peak bar chart; JCAMP shows an IR curve with correct axis labels; mzML shows a TIC chromatogram + selectable scan peaks.

## Self-Review
- Coverage: massspec classification (T1), decode for all 4 formats (T2), chart.js viewer (T3). ✓
- Placeholder scan: mzML/mzXML fixture acquisition is the one implementer-latitude item — explicitly required to be reported, not silently skipped.
- Type consistency: JSON keys in `massspec_helper.py` match the TS shape consumed by `spectrum-viewer.tsx` (`format`, `n_spectra`, `chromatogram`, `spectra[].mz/intensity`, `curve`, `x_label`, `y_label`).
