import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CsvViewer, CSV_PAGE_SIZE, parseCsv } from "./csv-viewer";

const content = "id,name\n" + Array.from({ length: 1001 }, (_, i) => `${i},sample-${i}`).join("\n");
describe("CSV pagination", () => {
  it("bounds rows and reaches later records through pagination and full-data search", () => {
    render(<CsvViewer content={content} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(CSV_PAGE_SIZE + 1);
    expect(screen.queryByText("sample-250")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("sample-250")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sample-1000" } });
    expect(screen.getByText("sample-1000")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByText("sample-0")).toBeInTheDocument();
  });
  it("copies the entire original file, not the visible page", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CsvViewer content={content} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy full CSV" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Full CSV copied");
    expect(writeText).toHaveBeenCalledWith(content);
  });
  it("keeps search clearable after a file shrinks", () => {
    const { rerender } = render(<CsvViewer content={content} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    rerender(<CsvViewer content="id,name\n1,small" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByText("small")).toBeInTheDocument();
  });
  it("keeps quoted-cell parsing and renders small files without pagination", () => {
    expect(parseCsv('x,y\n"a,b","c""d"')).toEqual([["x", "y"], ["a,b", 'c"d']]);
    render(<CsvViewer content="x,y\n1,2" />);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });
});
