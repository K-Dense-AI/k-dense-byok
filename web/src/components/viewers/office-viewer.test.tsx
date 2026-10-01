import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficeViewer from "./office-viewer";
vi.mock("@/lib/office-render", () => ({ renderOffice: vi.fn(async () => ({ html: "<p>Rendered document</p>" })) }));
vi.mock("./arraydata-viewer", () => ({ default: () => <div>Workbook data preview</div> }));
const original = { kind: "docx", revision: "a".repeat(64), readOnly: false, data: "", groups: [] };
let fetcher: ReturnType<typeof vi.fn>;
const props = { path: "report.docx", name: "report.docx", projectId: "office-tests", content: null };
beforeEach(() => { fetcher = vi.fn(async () => new Response(JSON.stringify(original))); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("opens the isolated full editor with the file's project and path", async () => {
  render(<OfficeViewer {...props} />); await screen.findByTitle("Word document preview");
  expect(screen.getByRole("link", { name: /Edit in Office/ })).toHaveAttribute("href", "/office?path=report.docx&project=office-tests");
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Project-Id")).toBe("office-tests");
});
it("refreshes after a matching save from the editor window", async () => {
  render(<OfficeViewer {...props} />); await screen.findByTitle("Word document preview");
  fireEvent(window, new StorageEvent("storage", { key: "kady:office-saved", newValue: JSON.stringify({ projectId: "another", path: props.path }) }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent(window, new StorageEvent("storage", { key: "kady:office-saved", newValue: JSON.stringify({ projectId: props.projectId, path: props.path }) }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
it("keeps spreadsheet data previews alongside the full editor", async () => {
  render(<OfficeViewer {...props} path="book.xlsx" name="book.xlsx" />);
  await screen.findByText("Workbook data preview"); expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /Edit in Office/ })).toHaveAttribute("href", "/office?path=book.xlsx&project=office-tests");
});
