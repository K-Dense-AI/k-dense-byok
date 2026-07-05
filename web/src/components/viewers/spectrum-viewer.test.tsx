import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SpectrumViewer from "./spectrum-viewer";

vi.mock("chart.js/auto", () => ({ default: class { constructor(){} update(){} destroy(){} } }));

const summary = {
  format: "mgf", mode: "spectra", title: "t", n_spectra: 2, x_label: "m/z", y_label: "intensity",
  chromatogram: null,
  spectra: [{ id: "spectrum 1", ms_level: 2, rt: null, precursor_mz: 445.1, mz: [100, 150], intensity: [200, 999] }],
  curve: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } })));
});

describe("SpectrumViewer", () => {
  it("renders header + spectrum info from the summary", async () => {
    render(<SpectrumViewer path="a.mgf" name="a.mgf" content={null} />);
    await waitFor(() => expect(screen.getByText(/2 spectra/i)).toBeInTheDocument());
    expect(screen.getByText(/spectrum 1/i)).toBeInTheDocument();
  });
  it("shows a friendly message on a 503 deps-missing response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "pyteomics not installed" }), { status: 503 })));
    render(<SpectrumViewer path="a.mzml" name="a.mzml" content={null} />);
    await waitFor(() => expect(screen.getByText(/unavailable|not installed/i)).toBeInTheDocument());
  });
});
