import { describe, it, expect } from "vitest";
import { fileCategory, sciSummaryUrl, sciRenderUrl } from "./use-sandbox";

describe("fileCategory — chemistry & structures", () => {
  it("classifies 2D molecule formats", () => {
    for (const n of ["a.smi", "a.smiles", "a.mol", "a.sdf", "a.mol2", "a.inchi"]) {
      expect(fileCategory(n)).toBe("molecule2d");
    }
  });
  it("classifies 3D structure formats", () => {
    for (const n of ["a.pdb", "a.ent", "a.cif", "a.mmcif", "a.xyz", "a.gro", "a.pdbqt"]) {
      expect(fileCategory(n)).toBe("structure3d");
    }
  });
  it("leaves existing formats unchanged", () => {
    expect(fileCategory("a.png")).toBe("image");
    expect(fileCategory("a.h5ad")).toBe("anndata");
    expect(fileCategory("a.py")).toBe("text");
  });
});

describe("fileCategory — mass spec", () => {
  it("classifies mass-spec & spectroscopy formats", () => {
    for (const n of ["a.mzml", "a.mzxml", "a.mgf", "a.jdx", "a.dx"]) {
      expect(fileCategory(n)).toBe("massspec");
    }
  });
});

describe("fileCategory — arraydata, phylo, alignment", () => {
  it("classifies array/omics formats", () => {
    for (const n of ["a.h5", "a.hdf5", "a.parquet", "a.npy", "a.npz", "a.nc", "a.cdf"]) {
      expect(fileCategory(n)).toBe("arraydata");
    }
  });
  it("classifies phylogenetic tree formats", () => {
    for (const n of ["a.nwk", "a.newick", "a.tree", "a.nhx"]) {
      expect(fileCategory(n)).toBe("phylo");
    }
  });
  it("classifies alignment formats", () => {
    for (const n of ["a.aln", "a.clustal", "a.sto", "a.stk", "a.phy", "a.phylip"]) {
      expect(fileCategory(n)).toBe("alignment");
    }
  });
  it("still classifies .h5ad/.h5ad.gz as anndata, not arraydata", () => {
    expect(fileCategory("a.h5ad")).toBe("anndata");
    expect(fileCategory("a.h5ad.gz")).toBe("anndata");
    // Plain .h5 (no "ad") is the new arraydata bucket.
    expect(fileCategory("a.h5")).toBe("arraydata");
  });
});

describe("sci url builders", () => {
  it("builds a summary url with kind + path", () => {
    const u = sciSummaryUrl("a/b.pdb", "structure");
    expect(u).toContain("/sandbox/sci-summary");
    expect(u).toContain("kind=structure");
    expect(u).toContain(encodeURIComponent("a/b.pdb"));
  });
  it("builds a render url with an index", () => {
    const u = sciRenderUrl("m.smi", "chem", 2);
    expect(u).toContain("/sandbox/sci-render.png");
    expect(u).toContain("kind=chem");
    expect(u).toContain("index=2");
  });
});
