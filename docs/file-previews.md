# File previews

Click any file in the project browser to open it in a built-in viewer — no download, no external app. Kady recognizes a wide range of scientific formats and renders each one appropriately: tables as tables, structures in 3D, spectra as plots, images as slice browsers.

Previews render in the browser and, for binary/scientific formats, in Python helpers on the BYOK backend host. The helper environment installs during setup. Large formats use bounded summaries or slice views; unsupported or oversized files remain available for download and analysis.

## What you can preview

### Documents & code
| Format | Extensions | Viewer |
|---|---|---|
| Images | `png` `jpg` `jpeg` `gif` `svg` `webp` `bmp` `ico` `heic` | Click to zoom to actual size; **annotate** with a red marker and save |
| PDF | `pdf` | Paged viewer with selectable user highlights/notes and live expert annotations from lead or delegated AI agents |
| Markdown | `md` `mdx` | Rendered, with LaTeX math and Mermaid diagrams |
| Jupyter notebooks | `ipynb` | Cells with rich outputs — images, HTML tables, tracebacks |
| CSV | `csv` | Sortable table |
| LaTeX | `tex` `latex` | Split-pane editor with autocomplete, outline & spell check, two-way SyncTeX pdf.js preview, inline compile diagnostics, AI fix/edit, and Ask Kady handoff |
| Anything else | any text file | Syntax-highlighted, **editable** source |

LaTeX AI assistance preserves scientific content and makes minimal compile
fixes. When the supplied snippet is insufficient, it explains the missing
context without changing the document. Proposed replacements still use the
existing diff review. A suggestion is not a verified compilation; recompile
after accepting it. Missing-context responses are billed like other AI calls.

The LaTeX editor offers **Source**, **Split**, and **PDF** views and remembers
the selected view and split width. PDF previews start fitted to the pane and
resize with it; manual zoom and **Fit width** remain available. **Compile on
save** runs after an explicit save (it does not autosave as you type).

The PDF is marked out of date after source edits, and a failed build keeps the
previously displayed preview with a failure notice. Compiler errors in the open
file are clickable in the log; stale line locations cannot launch AI fixes.
The diagnostic gutter uses the final compiler pass, so warnings resolved by
reruns disappear. Bibliography failures still fail the build even if a later
TeX pass produces a PDF. Long logs retain both their beginning and final summary.

Select source and choose **Edit with AI** (⌘K / Ctrl+K). For chapter files with a
`% !TEX root = ../main.tex` comment, AI assistance also reads the root preamble.
Finish the diff review before saving, compiling, or requesting another AI edit.
Edits typed during a save stay unsaved, and the editor's **Close** button prompts
before discarding them.

### Genomics & sequences
| Format | Extensions | Viewer |
|---|---|---|
| FASTA / FASTQ | `fasta` `fa` `faa` `fna` `ffn` `fastq` `fq` | Color-coded sequences, per-record length / GC% / quality bars |
| Bioinformatics tables | `vcf` `bcf` `bed` `gff` `gtf` `gff3` `sam` `tsv` | Column table with header metadata |
| Multiple-sequence alignments | `aln` `clustal` `sto` `stk` `phy` `phylip` | Color-coded residue grid (N sequences × L columns) |
| Phylogenetic trees | `nwk` `newick` `tree` `nhx` | SVG cladogram |

### Chemistry & structures
| Format | Extensions | Viewer |
|---|---|---|
| 2D molecules | `smi` `smiles` `inchi` `mol` `sdf` `mol2` | 2D depiction with formula, molecular weight, atom/bond counts (multi-molecule SDF shows a gallery) |
| 3D structures | `pdb` `ent` `cif` `mmcif` `xyz` `gro` `pdbqt` | **Interactive 3D viewer** — rotate/zoom — plus a summary card (chains, residues, ligands, resolution) |

### Mass spec & spectroscopy
| Format | Extensions | Viewer |
|---|---|---|
| Mass-spec runs & spectra | `mzml` `mzxml` `mgf` | Total-ion chromatogram plus a selectable per-scan peak plot |
| JCAMP-DX (NMR / IR / MS) | `jdx` `dx` | Spectral curve with correct axis units |

### Omics & data arrays
| Format | Extensions | Viewer |
|---|---|---|
| Single-cell (AnnData) | `h5ad` `h5ad.gz` | Structured card — obs/var columns, layers, embeddings you can color by any column |
| HDF5 | `h5` `hdf5` | Group / dataset tree plus selectable numeric heatmaps and line plots |
| Parquet | `parquet` | Schema, searchable/sortable row sample, selectable numeric scatter plot |
| NumPy | `npy` `npz` | Array selector, heatmap / line plot, multidimensional slice controls, displayed-value statistics |
| NetCDF | `nc` `nc4` `cdf` | Dimensions, root variables, attributes and numeric slice plots; masked values remain gaps |
| MATLAB | `mat` | Dense numeric variables from v4–v7.2 files; v7.3 uses the HDF5 dataset viewer and storage-axis order |
| Matrix Market | `mtx` | Dense or sparse matrix heatmap; sparse sources are sampled before conversion to a small dense grid |
| FITS images | `fits` `fit` `fts` | Image HDU selector, slice controls, heatmaps / line plots with FITS value scaling |

### Data tables & workbooks
| Format | Extensions | Viewer |
|---|---|---|
| Excel | `xlsx` | Sheet selector, table search / sort and numeric scatter plots; first row supplies headers, formulas show saved values |
| Arrow IPC / Feather v2 | `arrow` `ipc` `feather` | File or stream schema, row sample and numeric scatter plots |
| JSON Lines | `jsonl` `ndjson` | Sampled records as columns; nested values shown as JSON, with numeric scatter plots |
| SQLite | `sqlite` `sqlite3` `db` | Read-only ordinary-table selector, row sample, search / sort and numeric scatter plots |

Tables show up to **200 rows × 50 columns**; search, sorting and plots use only
that sample. Large cell text is capped at 512 characters. Where a format lacks
a cheap exact row count, the viewer explicitly reports that the total was not
scanned. SQLite views and virtual tables are excluded. JSON Lines columns are
inferred from displayed records. Charts omit missing/nonnumeric pairs; empty
cells and booleans are not treated as zero.

Numeric arrays show a line plot for vectors and a heatmap for matrices. For
higher dimensions, the slice control walks the leading dimensions in C order
while displaying the last two axes. Indices start at zero. Plots use at most
**1,024 vector points** or a **128 × 128 strided grid**. The viewer labels
sampling, missing values, and statistics from the displayed slice/sample;
these are not full-dataset statistics. Hover over a heatmap cell or plot point
to inspect its value. Striding can miss isolated features in large arrays.

HDF5/NetCDF and NumPy `.npy` previews read slices; Parquet reads a limited row
batch. XLSX expanded content, Arrow files/batches, individual NPZ arrays and
classic MATLAB files/variables have a 64 MiB preview ceiling. Matrix Market is
limited to 64 MiB and two million stored entries / axis. JSON Lines scans at
most 8 MiB, with a 1 MiB per-line limit. File/container metadata and codec work
can still require additional memory. Oversized inputs show an explanation and
remain available for download or analysis. Array/variable and sheet/table lists
are bounded and show truncation notices. NumPy object arrays are never unpickled;
HDF5 external links and external/virtual dataset storage are not followed.

### Bio-imaging
| Format | Extensions | Viewer |
|---|---|---|
| DICOM | `dcm` `dicom` | Slice image with technical metadata — **patient-identifying tags are never shown** |
| NIfTI | `nii` `nii.gz` | Slice browser with an axis selector (sagittal / coronal / axial) |
| Microscopy / TIFF | `tif` `tiff` `ome.tif` `ome.tiff` | Page/plane browser (RGB and multi-plane stacks) |

## Notes

- **View-only vs. editable.** Plain text and code are editable in place (⌘S to save); images can be annotated. The rich scientific viewers above are view-only — edit the underlying file with the agent or download it.
- **Text preview limits.** CSV files up to 8 MB show 250 rows per page with full-file search. Other text previews are limited to 512 KB. Larger files remain downloadable and available to the agent for analysis.
- **Reveal from chat.** When Kady references a file, line, or notebook cell, clicking it opens the file and jumps to that spot.
- **Provenance.** The preview header's **Provenance** button shows which tool call produced the file, what it read, its lineage back to uploaded data, and whether notebook citations are still current. See [Provenance](./provenance.md).
- **Missing dependency?** If the helper environment for a particular format hasn't finished installing, the viewer shows a friendly "preview unavailable" message instead of failing — reopen the file once setup completes.
- **Privacy.** DICOM previews omit patient-identifying fields from displayed metadata; this does not anonymize the underlying file. Hosted models, connectors or remote compute can receive data you ask the agent to use.

## Unsupported previews

There are no dedicated viewers for whole-slide imaging (`.svs`, `.ndpi`), GenBank/NEXUS annotated records, multi-channel OME-TIFF compositing or cross-file DICOM series stacking. The new data viewers do not cover legacy Excel `.xls`, ODS, Feather v1, FITS table HDUs, MATLAB cells/structs or nested NetCDF groups. NPZ previews accept NumPy header versions 1 and 2. Unrecognized files use the text fallback where possible; download binary formats or process them with the agent.
