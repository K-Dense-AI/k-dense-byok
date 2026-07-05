import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ArrayDataViewer from "./arraydata-viewer";

const ndarraySummary = {
  format: "npy",
  kind: "ndarray",
  file_size: 1234,
  arrays: [
    {
      name: "",
      shape: [3, 4],
      dtype: "float64",
      min: 0.1,
      max: 9.9,
      mean: 4.5,
      preview: [0.1, 1.2, 2.3, 3.4],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(ndarraySummary), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

describe("ArrayDataViewer", () => {
  it("renders shape/dtype and a stat for an ndarray summary", async () => {
    render(<ArrayDataViewer path="a.npy" name="a.npy" content={null} />);
    await waitFor(() => expect(screen.getByText(/3, 4/)).toBeInTheDocument());
    expect(screen.getByText(/float64/i)).toBeInTheDocument();
    expect(screen.getByText(/4\.5/)).toBeInTheDocument();
  });

  it("shows a friendly message on a 503 deps-missing response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "h5py not installed" }), { status: 503 }),
      ),
    );
    render(<ArrayDataViewer path="a.h5" name="a.h5" content={null} />);
    await waitFor(() => expect(screen.getByText(/not installed/i)).toBeInTheDocument());
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });
});
