"""SMILES/MOL/SDF preview helper. Shelled out to by the TS backend.

Usage:
  python chem_helper.py summarize <path>            -> JSON to stdout
  python chem_helper.py render <path> <index> <out> -> writes 2D SVG to <out>

Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path


def _rdkit():
    try:
        from rdkit import Chem
        from rdkit.Chem import Draw, Descriptors, rdMolDescriptors
        from rdkit.Chem.Draw import rdMolDraw2D
        return Chem, Draw, Descriptors, rdMolDescriptors, rdMolDraw2D
    except ImportError as exc:  # deps missing
        sys.stderr.write(f"RDKit not installed: {exc}\n")
        sys.exit(3)


def _load_mols(path: Path):
    Chem, *_ = _rdkit()
    ext = path.suffix.lower()
    if ext in (".smi", ".smiles"):
        mols = []
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            m = Chem.MolFromSmiles(parts[0])
            if m is not None:
                if len(parts) > 1:
                    m.SetProp("_Name", parts[1])
                mols.append(m)
        return mols
    if ext in (".mol", ".mol2"):
        m = Chem.MolFromMolFile(str(path)) if ext == ".mol" else Chem.MolFromMol2File(str(path))
        return [m] if m is not None else []
    if ext == ".sdf":
        return [m for m in Chem.SDMolSupplier(str(path)) if m is not None]
    if ext == ".inchi":
        m = Chem.MolFromInchi(path.read_text().strip())
        return [m] if m is not None else []
    return []


def summarize(path: Path) -> None:
    Chem, _Draw, Descriptors, rdMolDescriptors, _ = _rdkit()
    mols = _load_mols(path)
    if not mols:
        sys.stderr.write("No valid molecules parsed\n")
        sys.exit(5)
    out = {"format": path.suffix.lower().lstrip("."), "count": len(mols), "molecules": []}
    for i, m in enumerate(mols[:200]):
        out["molecules"].append({
            "index": i,
            "name": m.GetProp("_Name") if m.HasProp("_Name") else "",
            "formula": rdMolDescriptors.CalcMolFormula(m),
            "mol_weight": round(Descriptors.MolWt(m), 3),
            "num_atoms": m.GetNumAtoms(),
            "num_bonds": m.GetNumBonds(),
            "smiles": Chem.MolToSmiles(m),
        })
    sys.stdout.write(json.dumps(out))


def render(path: Path, index: int, out_path: Path) -> None:
    _Chem, _Draw, _Desc, _rdmd, rdMolDraw2D = _rdkit()
    mols = _load_mols(path)
    if index < 0 or index >= len(mols):
        sys.stderr.write("Molecule index out of range\n")
        sys.exit(4)
    d = rdMolDraw2D.MolDraw2DSVG(360, 300)
    d.DrawMolecule(mols[index])
    d.FinishDrawing()
    out_path.write_text(d.GetDrawingText())


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: chem_helper.py <summarize|render> <path> [...]\n")
        sys.exit(1)
    cmd, raw_path = sys.argv[1], Path(sys.argv[2])
    if not raw_path.exists():
        sys.stderr.write(f"File not found: {raw_path}\n")
        sys.exit(4)
    try:
        if cmd == "summarize":
            summarize(raw_path)
        elif cmd == "render":
            render(raw_path, int(sys.argv[3]), Path(sys.argv[4]))
        else:
            sys.stderr.write(f"unknown command: {cmd}\n")
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
