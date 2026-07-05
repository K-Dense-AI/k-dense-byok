# Scientific Format Preview — Phase 4 (Bio-Imaging) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Preview medical/scientific imaging — DICOM (`.dcm`), NIfTI (`.nii`/`.nii.gz`), and TIFF/OME-TIFF (`.tif`/`.tiff`/`.ome.tif`) — with metadata + an interactive slice/plane browser.

**Architecture:** Plan 4 of the phased spec, on the Phase-0 foundation. A Python `imaging_helper.py` decodes files (pydicom/nibabel/tifffile) exposing `summarize` (metadata + per-axis slice counts) and `render` (a chosen slice → PNG). The generic `sci-summary` endpoint returns metadata; the `sci-render.png` endpoint (extended to forward an optional `axis`) streams each slice PNG on demand. An `ImagingViewer` shows metadata + an axis selector + a slice slider driving `<img>` requests.

**Tech Stack:** Fastify+tsx, Next.js/React/TS, vitest, uv-managed Python (`pydicom`, `nibabel`, `tifffile`, `pillow`, `numpy`).

## Global Constraints

- `tsx` only; `npx tsc --noEmit` clean for web. Python deps only in `server/src/helpers/pyproject.toml` (run `uv sync` after adding).
- Helper exit-code contract: 0 ok / 3 deps missing / 4 not found / 5 bad value / 1 other. `render` writes a PNG to the out path.
- Registry additive; new viewers view-only (`canEditSource: false`, `loadMode: "none"`).
- Deps-gated Python tests: `it.runIf(depsOk)` + `15000` ms timeout.
- **DICOM PHI:** the summary must NOT echo patient-identifying tags. Whitelist safe technical tags only (Modality, Rows, Columns, dimensions, BitsAllocated, PhotometricInterpretation, window center/width, pixel spacing, etc.) — never PatientName/PatientID/PatientBirthDate/etc.
- Bound the browser payload: never send raw pixel arrays as JSON; pixels only ever leave as on-demand slice PNGs. Downsample huge slices in the PNG if needed (cap longest side, e.g. 1024 px).
- Company name is "K-Dense".

## File Structure

- Create: `server/src/helpers/imaging_helper.py` (`summarize` + `render`).
- Create: `web/src/components/viewers/imaging-viewer.tsx` (default export).
- Create tests: `server/test/imaging-helper.test.ts`, `web/src/components/viewers/imaging-viewer.test.tsx`.
- Modify: `use-sandbox.ts` (categories + ext handling incl. compound `.nii.gz`/`.ome.tif`; extend `sciRenderUrl` with `axis`), `file-preview-panel.tsx` (`categoryLabel`), `file-icon.tsx` (icons), `sandbox-fs.ts` (MIME), `pyproject.toml` (deps), `sci-helpers.ts` (`imaging` kind), `sandbox.ts` (extend `sci-render.png` to forward `axis`), `registry.ts` (register 3 categories).

---

### Task 1: Phase-4 foundation (classification, deps, render-axis plumbing)

**Files/edits:**
- `use-sandbox.ts`:
  - Add `"dicom" | "nifti" | "microscopy"` to `FileCategory`.
  - In `fileCategory`, BEFORE the generic `ext` split (alongside the existing `.h5ad`/`.h5ad.gz` special-case), add compound-extension handling: `if (lower.endsWith(".nii") || lower.endsWith(".nii.gz")) return "nifti";` and `if (lower.endsWith(".ome.tif") || lower.endsWith(".ome.tiff")) return "microscopy";`.
  - Add `MICROSCOPY_EXTS = new Set(["tif","tiff"])` and `if (MICROSCOPY_EXTS.has(ext)) return "microscopy";` and `if (ext === "dcm") return "dicom";` in the ext section.
  - **Remove `"tiff"` from `IMAGE_EXTS`** so TIFFs route to the microscopy viewer (browsers can't render TIFF via `<img>` anyway). Leave png/jpg/etc. as image.
  - Extend `sciRenderUrl(path, kind, index = 0, axis?: string)` — add `axis` to the query params when provided.
- `categoryLabel`: `if (cat==="dicom") return "dicom"; if (cat==="nifti") return "nifti"; if (cat==="microscopy") return "microscopy";`
- `file-icon.tsx`: add to existing lucide import `ScanIcon`, `BrainIcon`, `MicroscopeIcon`. `dicom → ScanIcon text-rose-600`, `nifti → BrainIcon text-fuchsia-600`, `microscopy → MicroscopeIcon text-amber-600`. (Place the `.nii.gz`/`.ome.tif` compound checks in `KadyFileIcon` too, mirroring the existing `.h5ad.gz` check, so the icon is right before the generic ext switch.)
- `sandbox-fs.ts` MIME: `.dcm` → `application/dicom`, `.nii` → `application/octet-stream`, `.tif`/`.tiff` → `image/tiff`. (`.nii.gz`/`.ome.tif` fall through fine.)
- `pyproject.toml`: add `"pydicom"`, `"nibabel"`, `"tifffile"`, `"pillow"`.
- `sci-helpers.ts`: `SciKind` += `"imaging"`; `KIND_TO_SCRIPT.imaging = "imaging_helper.py"`.
- `sandbox.ts` `sci-render.png` route: add `axis?: string` to the Querystring type and forward it: `runSciHelper(req.query.kind, "render", [target, req.query.index ?? "0", outPath, req.query.axis ?? "-"])`. (Backward-compatible: chem/structure render ignores the extra arg.)

- [ ] **Step 1: Failing tests** — `use-sandbox.test.ts`: `.dcm`→dicom, `.nii`→nifti, `.nii.gz`→nifti, `.tif`→microscopy, `.tiff`→microscopy, `.ome.tif`→microscopy, and `.png` STILL →image; a `sciRenderUrl("a.nii","imaging",5,"coronal")` contains `axis=coronal` & `index=5`. `backend.test.ts`: `sciHelperFor("imaging")` ends `imaging_helper.py`; `guessMime("a.dcm")==="application/dicom"`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the edits.
- [ ] **Step 4: Run — PASS**; `cd server/src/helpers && uv sync`; `cd web && npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(sci): classify DICOM/NIfTI/TIFF + render-axis plumbing`

---

### Task 2: imaging_helper.py (DICOM / NIfTI / TIFF)

**Files:** create `server/src/helpers/imaging_helper.py`; `server/test/imaging-helper.test.ts`; fixtures generated via the venv (Step 1).

**Interfaces:**
- `imaging_helper.py summarize <path>` → JSON `{ format:"dicom"|"nifti"|"tiff", file_size, shape:[...], dtype, axes:[{name,size}], default_axis, meta:{...} }`.
  - NIfTI `axes` = the three spatial axes as `[{name:"sagittal",size:shape[0]},{name:"coronal",size:shape[1]},{name:"axial",size:shape[2]}]`; `default_axis:"axial"`; `meta` includes voxel sizes + affine diagonal + intent if present.
  - DICOM `axes` = `[{name:"frame",size:N}]` (N = number of frames; 1 for single-frame); `meta` = **PHI-safe whitelist only** (Modality, Rows, Columns, BitsAllocated, PhotometricInterpretation, PixelSpacing, WindowCenter, WindowWidth, SeriesDescription-if-present-but-treat-as-technical → actually omit any free-text/name tags; keep numeric/enumerated technical tags).
  - TIFF `axes` = `[{name:"page",size:num_pages}]`; `meta` = shape/dtype/photometric/n_pages (+ OME axes if detectable).
- `imaging_helper.py render <path> <index> <out> <axis>` → writes a PNG of the selected slice/frame/page to `<out>`. `axis` selects the NIfTI plane (sagittal/coronal/axial); for DICOM/TIFF `axis` is ignored (`-`) and `index` selects the frame/page. Normalize intensities to 0–255 uint8 (per-slice min–max, or DICOM window if present); cap the longest side at 1024 px (downsample). Out-of-range index → exit 4.
- Exit-code contract as global.

- [ ] **Step 1: Write failing test + generate fixtures** (via the synced venv — robust, do NOT hand-author binary):
```bash
cd server/src/helpers && uv run python - <<'PY'
import os, shutil, numpy as np, nibabel as nib, tifffile
d="../../test/fixtures"; os.makedirs(d, exist_ok=True)
nib.save(nib.Nifti1Image(np.arange(4*5*6, dtype=np.int16).reshape(4,5,6), np.eye(4)), f"{d}/sample.nii.gz")
tifffile.imwrite(f"{d}/sample.tif", (np.random.default_rng(0).integers(0,255,(3,32,32))).astype(np.uint8))
from pydicom.data import get_testdata_file
shutil.copy(get_testdata_file("CT_small.dcm"), f"{d}/sample.dcm")
print("imaging fixtures written")
PY
```
Test (`imaging-helper.test.ts`) — `depsOk = spawnSync(helperPython(),["-c","import pydicom,nibabel,tifffile,PIL"]).status===0`; `it.runIf(depsOk)` (15000ms) for:
- NIfTI summarize: `format==="nifti"`, `axes` length 3 with names sagittal/coronal/axial, sizes `[4,5,6]`, `default_axis==="axial"`.
- NIfTI render: `render sample.nii.gz 2 <out> axial` → status 0, `<out>` starts with the PNG magic bytes (`\x89PNG`).
- DICOM summarize: `format==="dicom"`, `meta.Modality` present, and assert NO PHI key (`expect(Object.keys(meta)).not.toContain("PatientName")`).
- DICOM render: `render sample.dcm 0 <out> -` → PNG written.
- TIFF summarize: `format==="tiff"`, `axes[0].size===3`.
- `exits 4` on missing file; `exits 4` on out-of-range slice index.

- [ ] **Step 2: Run — FAIL** (helper missing).
- [ ] **Step 3: Implement `imaging_helper.py`.** Dispatch by extension (handle compound `.nii.gz`/`.ome.tif`). Import-guard each lib → exit 3. NIfTI: `nibabel.load`, `img.header.get_data_shape()`, voxel via `header.get_zooms()`; render: `img.dataobj` sliced along the axis (sagittal=`[i,:,:]`, coronal=`[:,i,:]`, axial=`[:,:,i]`) → 2D → normalize → PIL PNG. DICOM: `pydicom.dcmread`; frames from `NumberOfFrames` (default 1); `meta` from the PHI-safe whitelist; render: `ds.pixel_array` (frame index if multiframe), apply window if `WindowCenter`/`WindowWidth` present else min–max → PNG. TIFF: `tifffile.TiffFile`; `len(tif.pages)`; render: `tif.pages[index].asarray()` → 2D (take channel 0 if multi-channel) → normalize → PNG. Shared helper: `_to_png(arr2d, out, cap=1024)` normalizing to uint8 and downsampling with `PIL.Image.resize` if the longest side > cap. Missing file → 4; bad index → 4; parse failure → 5; other → 1.
- [ ] **Step 4: Run — PASS** (all three formats' summarize + render tests run, PHI assertion passes).
- [ ] **Step 5: Commit** `feat(helpers): imaging_helper for DICOM/NIfTI/TIFF`

---

### Task 3: ImagingViewer + register `dicom`/`nifti`/`microscopy`

**Files:** `web/src/components/viewers/imaging-viewer.tsx` (default export); register the 3 categories in `registry.ts` (each `{ loadMode:"none", Viewer: ImagingViewer, canEditSource:false, managesOwnScroll:true }`); test.

**Interfaces:**
- Fetch `sciSummaryUrl(path, "imaging")` for `{format, shape, dtype, axes:[{name,size}], default_axis, meta}`.
- Render: a metadata bar (format, shape, dtype, key meta); if `axes.length > 1` an axis `<select>`; a slice slider (`<input type=range>` 0..size-1 for the active axis) with the current index shown; and `<img src={sciRenderUrl(path,"imaging",index,activeAxis)}>` showing the slice. Debounce/just let the browser refetch on slider change (each index is a cache-friendly GET). Show a metadata table of `meta`. Loading/error/503 friendly card. Reset index to floor(size/2) when the axis changes.

- [ ] **Step 1: Failing test** — mock `fetch` to return a NIfTI-style summary (3 axes, sizes 4/5/6, default axial, meta with voxel + modality-ish keys). Assert: the metadata bar shows the format/shape; an axis selector with 3 options; a range slider present; an `<img>` whose `src` contains `kind=imaging` and `axis=axial`. A second test: 503 `{detail}` → friendly message. (Don't assert real pixels — the `<img>` src is enough; jsdom won't fetch it.)
- [ ] **Step 2: Run — FAIL** (module missing).
- [ ] **Step 3: Implement** `imaging-viewer.tsx` (default export) + register the 3 categories. Guard post-unmount updates; changing axis resets the slice index to the middle.
- [ ] **Step 4: Run — PASS** + `npx tsc --noEmit` clean + no new suite failures beyond baseline (~18).
- [ ] **Step 5: Commit** `feat(viewers): bio-imaging viewer (DICOM/NIfTI/TIFF slice browser)`

---

## Deferred (note, don't build here)
- Whole-slide imaging (`.svs`/`.ndpi`) pyramids; multi-channel OME-TIFF channel compositing/LUTs beyond single-plane; DICOM series stacking across files.

## Manual verification
Upload generated `sample.nii.gz`, `sample.dcm`, `sample.tif` → confirm: NIfTI shows a metadata bar + axis selector (sagittal/coronal/axial) + slice slider driving the rendered slice; DICOM shows PHI-free metadata + the CT slice; TIFF shows a page slider. Drag each slider and confirm the image updates.

## Self-Review
- Coverage: classification + render-axis plumbing (T1), DICOM/NIfTI/TIFF decode+render with PHI whitelist (T2), slice-browser viewer (T3). ✓ WSI/multichannel deferred.
- Type consistency: `imaging_helper.py` JSON (`format`, `axes:[{name,size}]`, `default_axis`, `meta`) matches `ImagingViewer`'s consumption; `sciRenderUrl(path,"imaging",index,axis)` matches the extended endpoint's `axis` param.
- Security: DICOM PHI whitelist is a hard requirement with a test assertion; pixels only leave as on-demand PNGs (bounded), never as JSON.
- Fixtures generated via the venv (nibabel/tifffile writers, pydicom test-data DICOM), not hand-authored binary.
