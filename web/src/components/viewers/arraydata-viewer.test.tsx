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

  it("does not display small nonzero array statistics as zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...ndarraySummary,
      arrays: [{ ...ndarraySummary.arrays[0], min: 1e-8, max: 3e-8, mean: 2e-8, preview: [1e-8, 3e-8] }],
    }))));
    render(<ArrayDataViewer path="small.npy" name="small.npy" content={null} />);
    await screen.findByText("0.00000001");
    expect(screen.getByText("0.00000003")).toBeInTheDocument();
    expect(screen.getByText("0.00000002")).toBeInTheDocument();
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

it("switches datasets and slices with project scope and clears selection on file changes", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const plot = { kind: "line", values: [[1, null, 3]], x: [0, 1, 2], y: [0], shape: [2, 3, 1], slice: 0, slices: 2,
    leading_indices: [0], sampled: false, stats: { min: 1, max: 3, mean: 2 }, missing: 1 };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...ndarraySummary,
    selected: "a", datasets: [{ key: "a", name: "a", shape: [2, 3, 1], dtype: "float32" },
      { key: "b", name: "b", shape: [2, 3, 1], dtype: "float32" }], plot,
  }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ArrayDataViewer path="cube.npz" name="cube.npz" projectId="owner" content={null} />);
  await waitFor(() => expect(screen.getByLabelText("Dataset")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "b" } });
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(2));
  expect(String((fetcher.mock.calls[1] as unknown[])[0])).toContain("key=b");
  await waitFor(() => expect(screen.getByLabelText("Next slice")).toBeEnabled());
  fireEvent.click(screen.getByLabelText("Next slice"));
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(3));
  const requested = String((fetcher.mock.calls[2] as unknown[])[0]);
  expect(requested).toContain("slice=1");
  expect(requested).toContain("project=owner");
  view.rerender(<ArrayDataViewer path="other.npy" name="other.npy" projectId="owner" content={null} />);
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(4));
  expect(String((fetcher.mock.calls[3] as unknown[])[0])).not.toContain("key=b");
  expect(String((fetcher.mock.calls[3] as unknown[])[0])).toContain("slice=0");
});

it("keeps sheet selection available after a failed request and retries", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const data = { format: "xlsx", kind: "table", file_size: 12, num_rows: 1, num_columns: 1,
    columns: [{ name: "value", dtype: "cell" }], head: [[1]], collections: ["Sheet 1", "Sheet 2"], selected: "Sheet 1" };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporary read error" }), { status: 500 }))
    .mockImplementation(async () => new Response(JSON.stringify({ ...data, selected: "Sheet 2" })));
  vi.stubGlobal("fetch", fetcher);
  render(<ArrayDataViewer path="book.xlsx" name="book.xlsx" content={null} />);
  await waitFor(() => expect(screen.getByLabelText("Sheet")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Sheet"), { target: { value: "Sheet 2" } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Temporary read error"));
  expect(screen.getByLabelText("Sheet")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("keeps slice navigation available for exact integer previews without a plot", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const fetcher = vi.fn(async (input: string) => {
    const slice = new URL(input, "http://localhost").searchParams.get("slice");
    return new Response(JSON.stringify({
      ...ndarraySummary, selected: "values",
      datasets: [{ key: "values", name: "values", shape: [2, 1, 2], dtype: "int64" }],
      plot: null, plot_note: "Integer values exceed browser numeric precision.",
      value_preview: slice === "1" ? ["9007199254740995"] : ["9007199254740993"],
    }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<ArrayDataViewer path="integers.npz" name="integers.npz" content={null} />);
  await screen.findByText("Values: 9007199254740993");
  fireEvent.click(screen.getByLabelText("Next slice"));
  await screen.findByText("Values: 9007199254740995");
  expect(screen.getByLabelText("Previous slice")).toBeEnabled();
  expect(screen.getByLabelText("Next slice")).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
