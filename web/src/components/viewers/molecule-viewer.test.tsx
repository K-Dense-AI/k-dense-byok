import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MoleculeViewer from "./molecule-viewer";

const summary = {
  format: "smi", count: 1,
  molecules: [{ index: 0, name: "ethanol", formula: "C2H6O", mol_weight: 46.07, num_atoms: 3, num_bonds: 2, smiles: "CCO" }],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
});

describe("MoleculeViewer", () => {
  it("renders molecule properties from the summary", async () => {
    render(<MoleculeViewer path="a.smi" name="a.smi" content="CCO ethanol" />);
    await waitFor(() => expect(screen.getByText("C2H6O")).toBeInTheDocument());
    expect(screen.getByText(/ethanol/)).toBeInTheDocument();
  });

  it("shows a friendly message when the summary dependency is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "RDKit not installed" }), { status: 503 }),
    ));
    render(<MoleculeViewer path="a.smi" name="a.smi" content="CCO" />);
    await waitFor(() => expect(screen.getByText(/dependency|unavailable/i)).toBeInTheDocument());
  });
});
