import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import StructureViewer from "./structure-viewer";

// 3Dmol touches WebGL which jsdom lacks — stub the dynamic import.
// `createViewer` is mutable per-test so we can simulate a failing load
// followed by a recovering one (see the self-healing test below).
let createViewerImpl: () => { addModel(): void; setStyle(): void; zoomTo(): void; render(): void; resize(): void; clear(): void } = () => ({
  addModel() {}, setStyle() {}, zoomTo() {}, render() {}, resize() {}, clear() {},
});
vi.mock("3dmol", () => ({
  createViewer: (...args: unknown[]) => createViewerImpl.apply(null, args as []),
}));

const summary = {
  format: "pdb", num_atoms: 4, num_chains: 1, chains: ["A"],
  num_residues: 1, num_ligands: 0, ligands: [], resolution: null, title: "TEST",
};

beforeEach(() => {
  createViewerImpl = () => ({ addModel() {}, setStyle() {}, zoomTo() {}, render() {}, resize() {}, clear() {} });
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

  it("shows no failure overlay on a successful render", async () => {
    render(<StructureViewer path="a.pdb" name="a.pdb" content={"ATOM ...\nEND\n"} />);
    await waitFor(() => expect(screen.getByText("TEST")).toBeInTheDocument());
    expect(screen.queryByText(/3D viewer failed to load/i)).not.toBeInTheDocument();
  });

  it("shows a failure overlay when the 3Dmol viewer throws", async () => {
    createViewerImpl = () => {
      throw new Error("no webgl context");
    };
    render(<StructureViewer path="a.pdb" name="a.pdb" content={"ATOM ...\nEND\n"} />);
    await waitFor(() =>
      expect(screen.getByText(/3D viewer failed to load: no webgl context/i)).toBeInTheDocument(),
    );
  });

  it("self-heals on rerender: overlay clears and the mount container survives after a prior failure", async () => {
    createViewerImpl = () => {
      throw new Error("no webgl context");
    };
    const { rerender } = render(
      <StructureViewer path="a.pdb" name="a.pdb" content={"ATOM ...\nEND\n"} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/3D viewer failed to load/i)).toBeInTheDocument(),
    );

    // Rerender the SAME component instance (no key change here — the real
    // fix for switching tabs is `key={path}` in file-preview-panel.tsx,
    // exercised separately) with new content/path and a working mock. This
    // exercises the two structure-viewer fixes directly: the effect resets
    // `viewerErr` on new content/name, and the mount div is never removed
    // from the tree, so a later successful `createViewer` call has
    // somewhere to render into.
    createViewerImpl = () => ({ addModel() {}, setStyle() {}, zoomTo() {}, render() {}, resize() {}, clear() {} });
    rerender(<StructureViewer path="b.pdb" name="b.pdb" content={"ATOM ...\nEND (v2)\n"} />);

    await waitFor(() =>
      expect(screen.queryByText(/3D viewer failed to load/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByText("TEST")).toBeInTheDocument();
  });
});
