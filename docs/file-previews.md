# File previews

Click any file in the project browser to open it in a built-in viewer — no download, no external app. Kady recognizes a wide range of scientific formats and renders each one appropriately: tables as tables, structures in 3D, spectra as plots, images as slice browsers.

Everything renders **locally**. Text-based formats load instantly; binary/scientific formats are decoded by a bundled Python helper environment that installs automatically on first run. Large files are summarized or streamed slice-by-slice rather than loaded whole, so a multi-hundred-MB volume still previews quickly.

## What you can preview

### Documents & code
| Format | Extensions | Viewer |
|---|---|---|
| Images | `png` `jpg` `jpeg` `gif` `svg` `webp` `bmp` `ico` `heic` | Click to zoom to actual size; **annotate** with a red marker and save |
| PDF | `pdf` | Paged viewer with an annotation layer |
| Markdown | `md` `mdx` | Rendered, with LaTeX math and Mermaid diagrams |
| Jupyter notebooks | `ipynb` | Cells with rich outputs — images, HTML tables, tracebacks |
| CSV | `csv` | Sortable table |
| LaTeX | `tex` `latex` | Split-pane editor with inline compile diagnostics |
| Anything else | any text file | Syntax-highlighted, **editable** source |

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
| HDF5 | `h5` `hdf5` | Group / dataset tree with shapes, dtypes, attributes |
| Parquet | `parquet` | Schema + first rows |
| NumPy | `npy` `npz` | Shape, dtype, min/max/mean, value preview (each array in an `.npz`) |
| NetCDF | `nc` `nc4` `cdf` | Dimensions, variables, and global attributes |

### Bio-imaging
| Format | Extensions | Viewer |
|---|---|---|
| DICOM | `dcm` `dicom` | Slice image with technical metadata — **patient-identifying tags are never shown** |
| NIfTI | `nii` `nii.gz` | Slice browser with an axis selector (sagittal / coronal / axial) |
| Microscopy / TIFF | `tif` `tiff` `ome.tif` `ome.tiff` | Page/plane browser (RGB and multi-plane stacks) |

## Notes

- **View-only vs. editable.** Plain text and code are editable in place (⌘S to save); images can be annotated. The rich scientific viewers above are view-only — edit the underlying file with the agent or download it.
- **Reveal from chat.** When Kady references a file, line, or notebook cell, clicking it opens the file and jumps to that spot.
- **Missing dependency?** If the helper environment for a particular format hasn't finished installing, the viewer shows a friendly "preview unavailable" message instead of failing — reopen the file once setup completes.
- **Privacy.** DICOM previews strip patient-identifying fields by default. As always, your files never leave your machine.

## Not yet supported

Whole-slide imaging (`.svs`, `.ndpi`), GenBank/NEXUS annotated records, multi-channel OME-TIFF compositing, and cross-file DICOM series stacking are on the roadmap. Any unrecognized file falls back to the syntax-highlighted text viewer.
