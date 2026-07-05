import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ImagingViewer from "./imaging-viewer";

const niftiSummary = {
  format: "nifti",
  file_size: 4096,
  shape: [4, 5, 6],
  dtype: "int16",
  axes: [
    { name: "sagittal", size: 4 },
    { name: "coronal", size: 5 },
    { name: "axial", size: 6 },
  ],
  default_axis: "axial",
  meta: { voxel_size: [1, 1, 1], intent: "none" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(niftiSummary), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

describe("ImagingViewer", () => {
  it("shows metadata bar, axis selector, slice slider, and the slice image", async () => {
    render(<ImagingViewer path="a.nii.gz" name="a.nii.gz" content={null} />);

    await waitFor(() => expect(screen.getByText(/nifti/i)).toBeInTheDocument());
    // metadata bar: format + shape
    expect(screen.getByText(/4, 5, 6/)).toBeInTheDocument();
    expect(screen.getByText(/int16/i)).toBeInTheDocument();

    // axis selector with 3 options
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);

    // range slider present
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider).toBeInTheDocument();
    expect(slider.max).toBe("5"); // axial size 6 -> 0..5

    // <img> src contains kind=imaging and axis=axial (the default axis)
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toContain("kind=imaging");
    expect(img.src).toContain("axis=axial");
  });

  it("shows a friendly message on a 503 deps-missing response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "pydicom not installed" }), { status: 503 }),
      ),
    );
    render(<ImagingViewer path="a.dcm" name="a.dcm" content={null} />);
    await waitFor(() => expect(screen.getByText(/not installed/i)).toBeInTheDocument());
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });
});
