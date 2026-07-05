import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PhyloViewer from "./phylo-viewer";

const NEWICK = "(A:1,(B:2,C:3):4);";

describe("PhyloViewer", () => {
  it("renders an SVG cladogram with leaf labels", () => {
    render(<PhyloViewer path="tree.nwk" name="tree.nwk" content={NEWICK} />);
    expect(document.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("shows a friendly message for malformed Newick content", () => {
    render(<PhyloViewer path="bad.nwk" name="bad.nwk" content="(A,B,(C,D);" />);
    expect(document.querySelector("svg")).toBeFalsy();
    expect(screen.getByText(/couldn.?t parse|failed|invalid/i)).toBeInTheDocument();
  });

  it("shows a too-large fallback beyond the ~500 leaf cap", () => {
    const leaves = Array.from({ length: 501 }, (_, i) => `L${i}`).join(",");
    render(<PhyloViewer path="big.nwk" name="big.nwk" content={`(${leaves});`} />);
    expect(screen.getByText(/too large/i)).toBeInTheDocument();
    expect(document.querySelector("svg")).toBeFalsy();
  });

  it("renders nothing but a loading state when content is not yet available", () => {
    render(<PhyloViewer path="tree.nwk" name="tree.nwk" content={null} />);
    expect(document.querySelector("svg")).toBeFalsy();
    expect(screen.queryByText(/couldn.?t parse/i)).not.toBeInTheDocument();
  });
});
