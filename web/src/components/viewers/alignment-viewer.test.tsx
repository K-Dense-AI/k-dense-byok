import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AlignmentViewer from "./alignment-viewer";

const CLUSTAL = `CLUSTAL W (1.83) multiple sequence alignment

seq1            MKTAYIAKQRQ-SFVKSHFSRQ
seq2            MKT--IAKQRQISFVKSHFSRQ
                ***  *****  *********
`;

describe("AlignmentViewer", () => {
  it("renders a summary and colored residue grid for a Clustal alignment", () => {
    render(<AlignmentViewer path="a.aln" name="a.aln" content={CLUSTAL} />);
    expect(screen.getByText(/2 sequences/i)).toBeInTheDocument();
    expect(screen.getByText("seq1")).toBeInTheDocument();
    expect(screen.getByText("seq2")).toBeInTheDocument();
    // residues are rendered as individual colored spans
    expect(screen.getAllByText("M").length).toBeGreaterThan(0);
  });

  it("shows a friendly message for unparseable content", () => {
    render(<AlignmentViewer path="bad.aln" name="bad.aln" content="not an alignment at all" />);
    expect(screen.getByText(/couldn.?t parse|failed|invalid/i)).toBeInTheDocument();
  });

  it("renders nothing but a loading state when content is not yet available", () => {
    render(<AlignmentViewer path="a.aln" name="a.aln" content={null} />);
    expect(screen.queryByText(/couldn.?t parse/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sequences/i)).not.toBeInTheDocument();
  });
});
