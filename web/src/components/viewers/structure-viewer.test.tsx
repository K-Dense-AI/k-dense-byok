import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import StructureViewer from "./structure-viewer";

// 3Dmol touches WebGL which jsdom lacks — stub the dynamic import.
vi.mock("3dmol", () => ({
  createViewer: () => ({ addModel() {}, setStyle() {}, zoomTo() {}, render() {}, resize() {}, clear() {} }),
}));

const summary = {
  format: "pdb", num_atoms: 4, num_chains: 1, chains: ["A"],
  num_residues: 1, num_ligands: 0, ligands: [], resolution: null, title: "TEST",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
});

describe("StructureViewer", () => {
  it("renders the metadata summary card", async () => {
    render(<StructureViewer path="a.pdb" name="a.pdb" content={"ATOM ...\nEND\n"} />);
    await waitFor(() => expect(screen.getByText("TEST")).toBeInTheDocument());
    expect(screen.getByText(/1 chain/i)).toBeInTheDocument();
  });
});
