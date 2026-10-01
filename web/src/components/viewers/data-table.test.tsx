import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import DataTable, { numericCell, type TableSummary } from "./data-table";
vi.mock("./data-plots", () => ({ NumericChart: ({ points, xLabel, yLabel }: { points: unknown[]; xLabel: string; yLabel: string }) =>
  <div data-testid="chart" data-points={JSON.stringify(points)}>{xLabel} / {yLabel}</div> }));
const summary: TableSummary = { format: "jsonl", kind: "table", file_size: 100, num_rows: null, num_columns: 3,
  columns: [{ name: "Name", dtype: "JSON" }, { name: "Time", dtype: "JSON" }, { name: "Value", dtype: "JSON" }],
  head: [["B", 10, 9], ["A", 2, 3], ["C", null, 5], ["D", "", false]], rows_truncated: true };

describe("data table previews", () => {
  it("sorts numeric columns and searches only the labeled sample", () => {
    render(<DataTable summary={summary} />);
    expect(screen.getByText(/total not scanned/)).toBeInTheDocument();
    expect(screen.getByText(/Search, sorting, and plots use this preview only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Value JSON" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("A")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search preview rows"), { target: { value: "B" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
  it("plots selected numeric pairs, omits missing values, and preserves nonuniform X values", () => {
    render(<DataTable summary={summary} />);
    fireEvent.click(screen.getByRole("button", { name: "Plot" }));
    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Y axis"), { target: { value: "2" } });
    expect(JSON.parse(screen.getByTestId("chart").getAttribute("data-points")!)).toEqual([{ x: 10, y: 9 }, { x: 2, y: 3 }]);
    expect(screen.getByText(/2 numeric pairs from 4 preview rows/)).toBeInTheDocument();
  });
  it("does not mistake nulls, booleans, identifiers, or nonfinite values for measurements", () => {
    for (const value of [null, undefined, "", " ", false, "NaN", "Infinity", "0x10", "9007199254740993"])
      expect(numericCell(value)).toBeNull();
    expect(numericCell("-1.25e-3")).toBe(-0.00125);
    expect(numericCell(0)).toBe(0);
  });
});
