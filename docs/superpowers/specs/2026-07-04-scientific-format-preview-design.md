# Scientific Format Preview Expansion — Design

- **Date:** 2026-07-04
- **Status:** Approved for planning
- **Area:** `web/` file preview panel + `server/` sandbox helpers

## Goal

Expand the preview/editor window (`FilePreviewPanel`) to render as many scientific
file formats as practical: chemistry structures, mass spectra, N-dimensional data
arrays, and bio-imaging volumes — in addition to the formats already supported
(image, pdf, markdown, csv, notebook, fasta/fastq, bio-tables, latex, anndata).

## Decisions (locked)

1. **Coverage:** all four families — chemistry & structures, mass spec &
   spectroscopy, omics & data arrays, bio-imaging.
2. **Decode strategy:** backend Python helpers (mirroring `anndata_helper.py`),
   which parse/decode files and return JSON summaries and/or rendered PNGs. The
   client renders interactively over that parsed data where interactivity matters.
3. **Dependency install:** one dedicated, uv-managed **helper virtual environment**
   synced **fully at server startup**, so every format works immediately after boot.
4. **3D structures:** interactive rendering uses a **client-side WebGL viewer
   (3Dmol.js, lazy-loaded)**; the backend still parses a metadata summary card.
   This is the only case requiring a client-side rendering *library* — a server
   PNG cannot rotate/zoom, and interactive protein viz is the point.

Note: text-based tree/alignment formats (Newick, Clustal, etc.) are parsed on the
client because they already arrive as strings in `tab.content` — the same way
existing text formats work. That is not a decode-strategy deviation; binary formats
all decode in the backend per decision #2.

## Current architecture (as-is)

- **Classification:** `fileCategory(name)` in `web/src/lib/use-sandbox.ts` maps an
  extension to one of 10 categories.
- **Dispatch:** `FileViewer` in `web/src/components/file-preview-panel.tsx`
  (~1940 lines) is a chain of `if (cat === ...)` returning a dedicated viewer.
- **Content loading:** text formats are fetched into `tab.content` (a string);
  `image`/`pdf`/`anndata` skip the text fetch and let their viewer pull bytes from
  a raw or dedicated backend URL.
- **Backend helper pattern:** `.h5ad` is handled by a standalone Python CLI
  (`server/src/helpers/anndata_helper.py`) invoked via
  `spawnSync(PYTHON, [helper, subcommand, ...])`, where `PYTHON = process.env.KADY_PYTHON || "python3"`.
  It returns a JSON summary (`/sandbox/anndata-summary`) and a rendered embedding
  PNG (`/sandbox/anndata-embedding.png`). Exit codes: `0` ok, `3` deps missing,
  `4` not-found, `5` bad-value, `1` other.
- **Icons/mime:** `web/src/components/file-icon.tsx` chooses an icon per category;
  `guessMime()` in `server/src/api/sandbox.ts` sets the Content-Type for raw serving.

### Known wrinkle to fix

The helper is invoked through `python3`/`KADY_PYTHON`, which is *not* the uv-managed
per-project sandbox venv. Today it works only if that interpreter happens to have
`anndata`/`h5py`/`matplotlib`. Adding more helpers makes this fragile, so the
design introduces a reproducible helper venv and routes all helpers at it.

## Target architecture

### 1. Format registry (frontend)

Replace the `if`-chain in `FileViewer` with a registry so each format is an
isolated, testable unit and adding a format is a one-line registration.

- `web/src/lib/viewers/registry.ts` — maps `FileCategory` → a `ViewerDef`:
  ```ts
  interface ViewerDef {
    load: "text" | "raw" | "none"; // "text" => fetch into tab.content; else viewer fetches itself
    Viewer: React.ComponentType<ViewerProps>; // lazy() for heavy viewers
    canEditSource: boolean;        // text-based sci formats keep the raw-source editor
    managesOwnScroll: boolean;     // replaces the hardcoded scroll list in the panel
  }
  ```
- Viewer components move to `web/src/components/viewers/*` (one file per format
  family). `FileViewer` becomes: look up `registry[cat]`, render `def.Viewer`.
- `use-sandbox.ts` `openFile` uses `def.load` (instead of the hardcoded
  `image/pdf/anndata` skip-list) to decide whether to fetch text.
- The panel's edit affordance uses `def.canEditSource` instead of the current
  `cat !== image/pdf/anndata` check. Text-based scientific formats (SMILES source,
  PDB text, mzML XML) keep a **"View source"** editor toggle; binary formats do not.

### 2. Helper virtual environment (backend)

- `server/helpers/pyproject.toml` (uv project) declaring all decoder deps
  (see per-family lists). A new `syncHelperVenv()` (parallel to `syncSandboxVenv`
  in `sandbox-seed.ts`) runs `uv sync` at server startup.
- Helper invocation resolves `PYTHON` to that venv's interpreter
  (`server/helpers/.venv/bin/python`), with `KADY_PYTHON` still honored as an
  override, and `python3` as last-resort fallback. The existing anndata helper
  moves onto this path too.
- Deps live only in the helper env — they are **not** added to the per-project
  sandbox `pyproject.toml` (the agent's env stays as-is).

### 3. Backend endpoint pattern

Two generic, kind-dispatched endpoints instead of a pair per format:

- `GET /sandbox/sci-summary?path=&kind=` → JSON summary.
- `GET /sandbox/sci-render.png?path=&kind=&...params` → PNG (for imaging slices,
  2D depictions, thumbnails). `params` carry slice index, channel, window, etc.

`kind` routes to a per-family helper module. Helper code is modular:
`chem_helper.py`, `massspec_helper.py`, `arrays_helper.py`, `imaging_helper.py`
(plus the existing `anndata_helper.py`), each a CLI with `summarize` / `render`
subcommands and the same exit-code contract. A thin dispatcher maps `kind` →
`(helper, subcommand)`.

Frontend URL builders live beside `anndataSummaryUrl` in `use-sandbox.ts`
(`sciSummaryUrl`, `sciRenderUrl`).

### 4. Client interactive layer

Parsed JSON from the backend feeds interactive client components:
- **Spectra** (mzML/mzXML/MGF/JCAMP): chart.js (already a dependency) — zoomable
  TIC chromatogram + selectable per-scan peak plots.
- **3D structures** (PDB/mmCIF/XYZ/GRO): lazy-loaded **3Dmol.js** canvas reading
  the raw file, beside a backend metadata summary card.
- **Tables/trees**: reuse the existing table viewer; render HDF5/NetCDF group
  trees and Newick phylogenies as lightweight SVG/DOM (client parse for the
  text-based tree formats).

## Format coverage

| Family | Formats (extensions) | Decode | Render |
|---|---|---|---|
| **Chemistry & structures** | SMILES/InChI (`.smi`, `.smiles`, `.inchi`), MOL/SDF/MOL2 (`.mol`, `.sdf`, `.mol2`) | RDKit → 2D SVG + props (formula, MW, atoms) | inline SVG; multi-molecule SDF → gallery |
| | PDB/mmCIF/XYZ/GRO/PDBQT (`.pdb`, `.ent`, `.cif`, `.mmcif`, `.xyz`, `.gro`, `.pdbqt`) | Python summary (chains, residues, ligands/HETATM, resolution) + static thumbnail | **client 3Dmol.js** (rotate/zoom/style) |
| **Mass spec & spectroscopy** | mzML/mzXML (`.mzml`, `.mzxml`), MGF (`.mgf`), JCAMP-DX (`.jdx`, `.dx`) | pyteomics/pymzml → TIC + per-scan peak lists JSON (large files summarized) | chart.js, zoomable |
| **Omics & arrays** | HDF5 (`.h5`, `.hdf5`), Parquet (`.parquet`), NumPy (`.npy`, `.npz`), NetCDF (`.nc`, `.cdf`) | h5py / pyarrow / numpy / netCDF4 → group tree, schema+head, shape/dtype/stats | tree card; reuse table viewer for tabular |
| | Newick (`.nwk`, `.newick`, `.tree`, `.nhx`); GenBank/alignments (`.gb`, `.gbk`, `.sto`, `.aln`, `.clustal`, `.phy`, `.nex`) | client parse (text) | SVG tree; alignment grid |
| **Bio-imaging** | DICOM (`.dcm`), NIfTI (`.nii`, `.nii.gz`), OME-TIFF/TIFF (`.tif`, `.tiff`, `.ome.tif`) | pydicom / nibabel / tifffile → sanitized metadata + slice/plane PNG | slice/channel sliders → param'd `sci-render.png` |

### Classification nuances

- `.tif`/`.tiff` currently classify as `image`. They will route to the microscopy
  viewer, which **falls back to a plain image** when the file is a single 2D plane
  (so ordinary TIFFs still just show as pictures).
- `.h5ad` keeps its existing dedicated viewer; generic `.h5`/`.hdf5` get the new
  HDF5 tree viewer.
- `.tsv`/`.vcf`/`.bed`/`.gff`/etc. keep the existing bio-table viewer.
- DICOM/NIfTI metadata rendering **strips PHI-risk patient identifier tags** by
  default in the summary card.

## New `FileCategory` values

Added to the union in `use-sandbox.ts`: `molecule2d`, `structure3d`, `massspec`,
`hdf5`, `parquet`, `ndarray`, `netcdf`, `phylo`, `sequence`, `dicom`, `nifti`,
`microscopy`. `file-icon.tsx` and `categoryLabel()` gain matching entries.

## Error handling & graceful degradation

- Helper exit code `3` (deps missing) → endpoint returns 503 → viewer shows a
  friendly "preview unavailable — dependency missing" card (should not occur given
  upfront sync, but kept as a safety net). Other non-zero → the existing
  `FileLoadError` with a Retry button.
- **File-size ceiling per format**: helpers summarize/downsample large inputs
  (e.g. mzML TIC + first N scans, array head + stats, imaging on-demand slices)
  and never stream multi-GB payloads to the browser. When a file exceeds a viewer's
  ceiling, the panel shows a "file too large to preview inline — download to view"
  state. Ceilings are surfaced (logged/visible), not silent.
- 3Dmol.js and any heavy client viewer are `React.lazy` + dynamically imported so
  they never enter the initial bundle.

## Phasing (each phase independently shippable)

- **Phase 0 — Foundation:** format registry refactor; split viewers into
  `web/src/components/viewers/*`; helper venv + startup sync + `PYTHON` routing
  (migrate anndata helper onto it); extend `fileCategory`/`file-icon`/`guessMime`;
  generic `sci-summary`/`sci-render.png` endpoints + URL builders.
- **Phase 1 — Chemistry & structures:** RDKit 2D depiction; 3Dmol.js interactive
  viewer + backend structure summary.
- **Phase 2 — Mass spec & spectroscopy:** mzML/mzXML/MGF/JCAMP parse + chart.js
  spectra.
- **Phase 3 — Omics & arrays:** HDF5/Parquet/NumPy/NetCDF cards; Newick +
  sequence/alignment viewers.
- **Phase 4 — Bio-imaging:** DICOM/NIfTI/OME-TIFF metadata + slice rendering.

## Testing

- **Frontend (vitest):** `fileCategory` classification for every new extension;
  registry lookup; each viewer renders a small fixture without crashing; large-file
  fallback state; edit-source toggle gating.
- **Backend (vitest):** each `sci-summary`/`sci-render.png` route against tiny
  committed fixtures; deps-missing (503) and not-found (404) paths; `.tiff`
  single-plane fallback; PHI-tag stripping for DICOM.
- **Helper CLIs:** exit-code contract per subcommand.
- Small representative fixtures committed per format (kept minimal).

## Out of scope / deferred

- Whole-slide imaging (`.svs`, `.ndpi`) and multi-GB microscopy pyramids.
- Alignment/index-backed genomics (`.bam`, `.cram`, `.bigWig`) requiring server-side
  indexing.
- Molecular-dynamics trajectories (`.xtc`, `.dcd`, `.trr`).
- Editing/writing scientific binaries (all new viewers are view-only; text-based
  ones keep raw-source editing).
- Proprietary vendor microscopy (`.czi`, `.nd2`) and raw NMR vendor directories.

## Risks

- **Install footprint:** the upfront helper sync pulls heavy wheels (rdkit,
  nibabel, pyarrow, tifffile) — slower first boot and larger disk use. Accepted per
  decision #3; sync is best-effort and non-blocking to the rest of startup.
- **RDKit availability:** distributed as `rdkit` wheels on PyPI; verify install on
  the target platforms during Phase 1.
- **3Dmol.js bundle:** mitigated by lazy loading.
- **Panel refactor regressions:** Phase 0 must preserve current behavior for all
  existing formats; covered by keeping/extending existing viewer tests.
