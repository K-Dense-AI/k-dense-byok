"""PDB/mmCIF/XYZ metadata helper. Shelled out to by the TS backend.

Usage:
  python structure_helper.py summarize <path>  -> JSON to stdout

Interactive 3D rendering happens client-side (3Dmol.js); there is no `render`.
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

_STD_AA = {
    "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
    "MET","PHE","PRO","SER","THR","TRP","TYR","VAL","SEC","PYL",
}
_WATER = {"HOH", "WAT"}


def _summarize_xyz(path: Path) -> dict:
    lines = path.read_text().splitlines()
    try:
        n = int(lines[0].strip())
    except (ValueError, IndexError):
        sys.stderr.write("Malformed XYZ header\n")
        sys.exit(5)
    elements = []
    for line in lines[2:2 + n]:
        parts = line.split()
        if parts:
            elements.append(parts[0])
    return {
        "format": "xyz", "num_atoms": len(elements), "num_chains": 0, "chains": [],
        "num_residues": 0, "num_ligands": 0, "ligands": [], "resolution": None,
        "title": path.stem,
    }


def _summarize_gemmi(path: Path) -> dict:
    try:
        import gemmi
    except ImportError as exc:
        sys.stderr.write(f"gemmi not installed: {exc}\n")
        sys.exit(3)
    try:
        st = gemmi.read_structure(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Could not parse structure: {exc}\n")
        sys.exit(5)
    model = st[0] if len(st) else None
    chains, ligands, n_atoms, n_res = [], set(), 0, 0
    if model is not None:
        for chain in model:
            chains.append(chain.name)
            for res in chain:
                n_res += 1
                n_atoms += len(res)
                nm = res.name.strip()
                if nm not in _STD_AA and nm not in _WATER:
                    ligands.add(nm)
    return {
        "format": path.suffix.lower().lstrip("."),
        "num_atoms": n_atoms,
        "num_chains": len(chains),
        "chains": chains,
        "num_residues": n_res,
        "num_ligands": len(ligands),
        "ligands": sorted(ligands)[:50],
        "resolution": st.resolution if st.resolution and st.resolution > 0 else None,
        "title": (st.name or path.stem),
    }


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: structure_helper.py summarize <path>\n")
        sys.exit(1)
    cmd, raw = sys.argv[1], Path(sys.argv[2])
    if not raw.exists():
        sys.stderr.write(f"File not found: {raw}\n")
        sys.exit(4)
    if cmd != "summarize":
        sys.stderr.write("structure_helper only supports 'summarize'\n")
        sys.exit(1)
    data = _summarize_xyz(raw) if raw.suffix.lower() == ".xyz" else _summarize_gemmi(raw)
    sys.stdout.write(json.dumps(data))


if __name__ == "__main__":
    main()
