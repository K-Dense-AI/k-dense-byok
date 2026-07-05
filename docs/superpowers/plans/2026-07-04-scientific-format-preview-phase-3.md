# Scientific Format Preview — Phase 3 (Omics & Data Arrays) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Preview N-dimensional/tabular scientific data (HDF5, Parquet, NumPy `.npy`/`.npz`, NetCDF) and phylogenetics/alignments (Newick trees; Clustal/Stockholm/PHYLIP/aligned-FASTA) in the panel.

**Architecture:** Plan 3 of the phased spec, on the proven Phase-0 foundation. Binary array formats decode in a Python `arrays_helper.py` via the `sci-summary` endpoint (`kind="arrays"`) → bounded JSON → an `ArrayDataViewer` that switches on a `kind` field. Newick and alignments are text formats parsed client-side (no backend) into an SVG tree / colored residue grid.

**Tech Stack:** Fastify+tsx, Next.js/React/TS, vitest, uv-managed Python (`h5py` [already], `pyarrow`, `netCDF4`, `numpy` [already]).

## Global Constraints

- `tsx` only; `npx tsc --noEmit` clean for web. Python deps only in `server/src/helpers/pyproject.toml` (run `uv sync` after adding).
- Helper exit-code contract: 0 ok / 3 deps missing / 4 not found / 5 bad value / 1 other.
- Registry additive; new viewers view-only (`canEditSource: false`). Backend-decoded viewers use `loadMode: "none"`; client-parsed text viewers (Newick, alignments) use `loadMode: "text"` (they read `content`) with `canEditSource: false`.
- Deps-gated Python tests: `it.runIf(depsOk)` + `15000` ms timeout.
- Bound payloads: HDF5 tree ≤500 nodes; Parquet ≤50 columns metadata + ≤50 head rows; ndarray preview ≤100 flattened values + summary stats; NetCDF ≤200 variables. `num_rows`/true totals reported.
- Company name is "K-Dense".

## File Structure

- Create: `server/src/helpers/arrays_helper.py` (`summarize` only; dispatch by extension).
- Create: `web/src/components/viewers/arraydata-viewer.tsx`, `web/src/components/viewers/phylo-viewer.tsx`, `web/src/components/viewers/alignment-viewer.tsx` (all default exports).
- Create: `web/src/lib/newick.ts` (pure Newick parser) + `web/src/lib/alignment.ts` (pure alignment parsers), each with a `.test.ts`.
- Create tests: `server/test/arrays-helper.test.ts`, `web/src/components/viewers/arraydata-viewer.test.tsx`, `.../phylo-viewer.test.tsx`, `.../alignment-viewer.test.tsx`.
- Modify: `use-sandbox.ts` (categories `arraydata`/`phylo`/`alignment` + ext sets + `fileCategory`), `file-preview-panel.tsx` (`categoryLabel`), `file-icon.tsx` (icons), `sandbox-fs.ts` (MIME), `pyproject.toml` (`pyarrow`,`netCDF4`), `sci-helpers.ts` (`arrays` kind), `registry.ts` (register the 3 categories).

---

### Task 1: Phase-3 foundation

**Files/edits:**
- `use-sandbox.ts`: add to `FileCategory`: `"arraydata" | "phylo" | "alignment"`. Ext sets:
  `ARRAYDATA_EXTS = ["h5","hdf5","parquet","npy","npz","nc","cdf"]`,
  `PHYLO_EXTS = ["nwk","newick","tree","nhx"]`,
  `ALIGNMENT_EXTS = ["aln","clustal","sto","stk","phy","phylip"]`.
  In `fileCategory`, before the `text` fallback (and note: `.h5ad`/`.h5ad.gz` is already special-cased to `anndata` at the top, so plain `.h5` → arraydata is safe): add the three `Set.has(ext)` checks.
- `categoryLabel`: `if (cat==="arraydata") return ext==="parquet"?"parquet":ext==="npy"||ext==="npz"?"ndarray":ext==="nc"||ext==="cdf"?"netcdf":"hdf5"; if (cat==="phylo") return "phylo tree"; if (cat==="alignment") return "alignment";`
- `file-icon.tsx`: add to existing lucide import `Grid3x3Icon`, `GitForkIcon`, `AlignJustifyIcon`. `arraydata → Grid3x3Icon text-cyan-600`, `phylo → GitForkIcon text-lime-600`, `alignment → AlignJustifyIcon text-violet-600`.
- `sandbox-fs.ts` MIME: `.h5`/`.hdf5` → `application/x-hdf5`, `.parquet` → `application/vnd.apache.parquet`, `.npy`/`.npz` → `application/octet-stream`, `.nc`/`.cdf` → `application/x-netcdf`, `.nwk`/`.newick`/`.tree`/`.nhx` → `text/plain`, `.aln`/`.clustal`/`.sto`/`.stk`/`.phy`/`.phylip` → `text/plain`.
- `pyproject.toml`: add `"pyarrow"`, `"netCDF4"`.
- `sci-helpers.ts`: `SciKind` += `"arrays"`; `KIND_TO_SCRIPT.arrays = "arrays_helper.py"`.

- [ ] **Step 1: Failing tests** — extend `use-sandbox.test.ts` (classify each new ext), `backend.test.ts` (`sciHelperFor("arrays")` ends `arrays_helper.py`; `guessMime("a.parquet")`/`guessMime("a.nwk")`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the edits above.
- [ ] **Step 4: Run — PASS**; `cd server/src/helpers && uv sync`; `cd web && npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(sci): classify omics/array + phylo + alignment formats`

---

### Task 2: arrays_helper.py (HDF5 / Parquet / npy·npz / NetCDF)

**Files:** create `server/src/helpers/arrays_helper.py`; `server/test/arrays-helper.test.ts`; fixtures generated via the venv (see Step 1).

**Interfaces:** `arrays_helper.py summarize <path>` → JSON with a `kind` discriminator:
- HDF5 (`kind:"tree"`): `{ format:"hdf5", kind:"tree", file_size, tree:[{path,type:"group"|"dataset",shape?,dtype?,attrs?}], truncated:bool }` (≤500 nodes, depth-first).
- Parquet (`kind:"table"`): `{ format:"parquet", kind:"table", file_size, num_rows, num_columns, columns:[{name,dtype}], head:[[cell,...],...] }` (≤50 cols, ≤50 head rows; cells stringified).
- npy/npz (`kind:"ndarray"`): `{ format:"npy"|"npz", kind:"ndarray", file_size, arrays:[{name,shape,dtype,min,max,mean,preview:[num]}] }` (npy → one array name=""; npz → each member; preview ≤100 flattened values; min/max/mean only for numeric dtypes, else null).
- NetCDF (`kind:"variables"`): `{ format:"netcdf", kind:"variables", file_size, dimensions:{name:size}, variables:[{name,dims,shape,dtype,attrs}], global_attrs }` (≤200 vars).
- Exit-code contract as global.

- [ ] **Step 1: Write failing test + generate fixtures.** Generate tiny committed fixtures with the synced venv (robust — do NOT hand-author binary):
```bash
cd server/src/helpers && uv run python - <<'PY'
import numpy as np, h5py, pyarrow as pa, pyarrow.parquet as pq, netCDF4, os
d="../../test/fixtures"; os.makedirs(d, exist_ok=True)
np.save(f"{d}/sample.npy", np.arange(12, dtype=float).reshape(3,4))
np.savez(f"{d}/sample.npz", a=np.arange(5), b=np.ones((2,2)))
with h5py.File(f"{d}/sample.h5","w") as f:
    g=f.create_group("grp"); g.create_dataset("ds", data=np.arange(6).reshape(2,3)); f.attrs["note"]="hi"
pq.write_table(pa.table({"x":[1,2,3],"y":["a","b","c"]}), f"{d}/sample.parquet")
nc=netCDF4.Dataset(f"{d}/sample.nc","w"); nc.createDimension("t",3); v=nc.createVariable("temp","f4",("t",)); v[:]=[1,2,3]; v.units="K"; nc.title="demo"; nc.close()
print("fixtures written")
PY
```
Test (`server/test/arrays-helper.test.ts`) — `depsOk = spawnSync(helperPython(),["-c","import h5py,pyarrow,netCDF4"]).status===0`; `it.runIf(depsOk)` (15000ms) for each format asserting the discriminator + key fields: npy shape `[3,4]` & dtype float & preview length; npz two arrays `a`,`b`; hdf5 tree contains a path ending `/grp/ds` with type dataset; parquet `num_rows===3`, columns `x`,`y`, head length 3; netcdf variable `temp` with dim `t`, `global_attrs.title==="demo"`. Plus an always-run `exits 4 on missing file`.

- [ ] **Step 2: Run — FAIL** (helper missing).
- [ ] **Step 3: Implement `arrays_helper.py`.** Dispatch on extension. HDF5: `h5py.File`, walk groups/datasets DFS capping at 500 nodes, record shape/dtype/str-attrs. Parquet: `pyarrow.parquet.read_metadata` for schema/num_rows + `read_table().slice(0,50).to_pylist()` for head (stringify cells). npy: `numpy.load(path)`; npz: `numpy.load(path)` iterate `.files`; for each ndarray record shape/dtype and, if numeric, min/max/mean + a ≤100-value flattened preview (`arr.ravel()[:100].tolist()`, cast to float where numeric). NetCDF: `netCDF4.Dataset`, read `.dimensions`, `.variables` (name/dims/shape/dtype/attrs), and global attrs. Import guards per format → exit 3 with a clear message. Missing file → exit 4; unreadable/parse failure → exit 5; other → 1.
- [ ] **Step 4: Run — PASS** (all four formats' tests run, not skipped).
- [ ] **Step 5: Commit** `feat(helpers): arrays_helper for HDF5/Parquet/npy/NetCDF`

---

### Task 3: ArrayDataViewer + register `arraydata`

**Files:** `web/src/components/viewers/arraydata-viewer.tsx` (default export); register in `registry.ts` (`arraydata: { loadMode:"none", canEditSource:false, managesOwnScroll:true }`); test.

**Interfaces:** fetch `sciSummaryUrl(path,"arrays")`; switch on `summary.kind`:
- `tree` → indented list of `tree[]` (mono path, type badge, shape·dtype).
- `table` → header line (`num_rows` rows · `num_columns` cols) + an HTML table of `columns`/`head` (reuse the styling idiom from the existing CSV/bio-table viewers in `file-preview-panel.tsx`).
- `ndarray` → one card per array: name, `shape` · `dtype`, min/max/mean, and a truncated preview.
- `variables` → a `dimensions` chip row + a variables table (name/dims/shape/dtype) + global-attrs list.
Handle loading/error/503 with a friendly card.

- [ ] **Step 1: Failing test** — mock `fetch` to return a `kind:"ndarray"` summary (one array, shape `[3,4]`, dtype `float64`, min/max/mean, preview) and assert the shape/dtype and a stat render; a second test with a `503 {detail}` asserting a friendly message. Real DOM assertions.
- [ ] **Step 2: FAIL** (module missing).
- [ ] **Step 3: Implement** the viewer (default export) + register `arraydata`.
- [ ] **Step 4: PASS** + `tsc --noEmit` clean + no new suite failures beyond baseline (~18).
- [ ] **Step 5: Commit** `feat(viewers): array-data viewer (HDF5/Parquet/npy/NetCDF)`

---

### Task 4: Newick phylo viewer (client-side)

**Files:** `web/src/lib/newick.ts` + `newick.test.ts`; `web/src/components/viewers/phylo-viewer.tsx` (default export) + test; register `phylo: { loadMode:"text", canEditSource:false, managesOwnScroll:true }`.

**Interfaces:**
- `web/src/lib/newick.ts`: `export interface PhyloNode { name: string; length: number | null; children: PhyloNode[] } ; export function parseNewick(text: string): PhyloNode` — parses standard Newick (nested parens, `name:length`, comma-separated children, trailing `;`). Throws on malformed input.
- `PhyloViewer({content})`: parses `content` with `parseNewick`; renders a simple rectangular cladogram as inline SVG (compute leaf y-positions in order, internal node y = mean of children, x = depth scaled by cumulative branch length or by depth; draw horizontal + vertical connector lines; label leaves). Cap at ~500 leaves with a "tree too large" fallback. On parse error, a friendly message.

- [ ] **Step 1: Failing tests** — `newick.test.ts`: `parseNewick("(A:1,(B:2,C:3):4);")` → root has 2 children; leaf names `A`,`B`,`C` found; `B.length===2`. `phylo-viewer.test.tsx`: render with that Newick `content` → an `<svg>` present and text `A`/`B`/`C` rendered; malformed content → friendly error.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `newick.ts` then `phylo-viewer.tsx`; register `phylo`.
- [ ] **Step 4: PASS** + tsc clean + baseline.
- [ ] **Step 5: Commit** `feat(viewers): Newick phylogenetic tree viewer`

---

### Task 5: Multiple-sequence-alignment viewer (client-side)

**Files:** `web/src/lib/alignment.ts` + `alignment.test.ts`; `web/src/components/viewers/alignment-viewer.tsx` (default export) + test; register `alignment: { loadMode:"text", canEditSource:false, managesOwnScroll:true }`.

**Interfaces:**
- `web/src/lib/alignment.ts`: `export interface AlignRow { id: string; seq: string } ; export function parseAlignment(text: string, ext: string): AlignRow[]` — supports Clustal (`.aln`/`.clustal`; header line "CLUSTAL", blocks of `id seq`), Stockholm (`.sto`/`.stk`; `# STOCKHOLM`, `id seq`, `//`), PHYLIP (`.phy`/`.phylip`; first line "count length", then `id seq`), and aligned FASTA fallback. Returns rows with equal-length gapped sequences. Throws/returns [] on unparseable.
- `AlignmentViewer({content,name})`: parse via `parseAlignment(content, ext)`; render a scrollable grid — row labels (ids) + a monospace residue grid, colored by residue reusing the DNA/protein color maps' spirit (you may import/replicate the small color maps from `file-preview-panel.tsx`'s FASTA viewer, or define a compact local one). Show a summary (N sequences × L columns). Cap rendered columns (e.g. 1000) + rows (e.g. 200) with a "truncated" note. Friendly message on parse failure.

- [ ] **Step 1: Failing tests** — `alignment.test.ts`: a small Clustal fixture string → 2+ rows, equal seq lengths, correct ids; a PHYLIP string → correct count. `alignment-viewer.test.tsx`: render Clustal `content` → summary "N sequences", ids and residues present; unparseable → friendly message.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `alignment.ts` then `alignment-viewer.tsx`; register `alignment`.
- [ ] **Step 4: PASS** + tsc clean + baseline.
- [ ] **Step 5: Commit** `feat(viewers): multiple-sequence-alignment viewer (Clustal/Stockholm/PHYLIP)`

---

## Deferred (note, don't build here)
- GenBank (`.gb`/`.gbk`) annotated records and NEXUS (`.nex`) — heavier; separate follow-up.

## Manual verification
Upload generated `sample.h5`/`sample.parquet`/`sample.npy`/`sample.nc`, a `.nwk`, and a `.aln` → confirm the tree/table/stats/variables render, the phylogram draws, and the alignment grid colors residues.

## Self-Review
- Coverage: arraydata (T1-T3), phylo (T4), alignment (T5). ✓ GenBank/NEXUS explicitly deferred.
- Type consistency: `arrays_helper.py` JSON `kind` discriminator + per-kind fields match `ArrayDataViewer`'s switch. `parseNewick`/`parseAlignment` signatures match their viewers.
- Fixtures generated via the venv (robust), not hand-authored binary.
