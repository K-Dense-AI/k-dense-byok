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
