import React, { Suspense, useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: (loader: () => Promise<React.ComponentType>) => {
  const Lazy = React.lazy(async () => ({ default: await loader() }));
  return (props: object) => <Suspense fallback={<div>Loading</div>}><Lazy {...props} /></Suspense>;
} }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
// Keep the real editor components and their draft/save state; substitute only
// CodeMirror's browser DOM with a textarea that retains its own document.
vi.mock("@uiw/react-codemirror", async (original) => ({
  ...await original<object>(),
  default: function Editor({ value, onChange, readOnly }: { value: string; onChange: (s: string) => void; readOnly?: boolean }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return <textarea aria-label={readOnly ? "Viewer" : "Editor"} value={text} onChange={(event) => {
      setText(event.target.value);
      onChange?.(event.target.value);
    }} />;
  },
}));
vi.mock("@/components/ai-elements/message", () => ({ MessageResponse: () => null }));
vi.mock("@/components/pdf-viewer/pdf-viewer", () => ({ PdfViewer: () => null }));
vi.mock("@/components/file-icon", () => ({ KadyFileIcon: () => null }));
vi.mock("@/components/lab-notebook-view", () => ({ LabNotebookView: () => null }));
vi.mock("@/components/modal-jobs-panel", () => ({ ModalJobsPanel: () => null }));
vi.mock("@/components/automation-panel", () => ({ AutomationPanel: () => null }));
vi.mock("@/components/provenance-panel", () => ({ ProvenancePanel: () => null }));
vi.mock("./csv-viewer", () => ({ CsvViewer: () => null }));
import { FilePreviewPanel } from "./file-preview-panel";

function panelProps(path = "a.txt"): React.ComponentProps<typeof FilePreviewPanel> {
  return {
    projectId: "project-a",
    tabs: [{ path, content: "original A", loading: false }, { path: "b.txt", content: "original B", loading: false }],
    activeTabPath: path, onTabSelect: vi.fn(), onTabClose: vi.fn(), onDownload: vi.fn(),
    onSaveText: vi.fn(async () => true), onSaveImageBlob: vi.fn(async () => true),
    onCompileLatex: vi.fn(), showNotebook: false, onSelectNotebook: vi.fn(), showCompute: false,
    onSelectCompute: vi.fn(), computeSessionId: null, computeScope: "project", onComputeScopeChange: vi.fn(),
    onOpenComputeOutput: vi.fn(), notebookSessionId: null, notebookEntries: [], notebookStreaming: false,
    notebookSubagentCompletions: 0, onOpenNotebookFile: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(["a.txt", "a.tex"])("retains %s draft across file, notebook, compute, and project navigation", async (path) => {
  const props = panelProps(path);
  const { rerender } = render(<FilePreviewPanel {...props} />);
  fireEvent.click(screen.getByTitle("Edit file"));
  fireEvent.change(await screen.findByRole("textbox", { name: "Editor" }), { target: { value: "valuable unsaved A" } });
  expect(screen.queryByTitle("Where this file came from")).toBeNull();
  for (const change of [{ activeTabPath: "b.txt" }, { showNotebook: true }, { showCompute: true }, { isActive: false }]) {
    rerender(<FilePreviewPanel {...props} {...change} />);
    expect(screen.queryByRole("textbox", { name: "Editor" })).toBeNull();
    rerender(<FilePreviewPanel {...props} />);
    expect((await screen.findByRole("textbox", { name: "Editor" }) as HTMLTextAreaElement).value).toBe("valuable unsaved A");
  }
  expect(props.onSaveText).not.toHaveBeenCalled();
  // The surviving editor saves through its owning workspace's callback/path.
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Save$|^Save / })); });
  expect(props.onSaveText).toHaveBeenCalledWith(path, "valuable unsaved A");
});

it("requires confirmation to close a dirty file tab or text editor", async () => {
  const props = panelProps();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<FilePreviewPanel {...props} />);
  fireEvent.click(screen.getByTitle("Edit file"));
  fireEvent.change(await screen.findByRole("textbox", { name: "Editor" }), { target: { value: "unsaved" } });
  fireEvent.click(screen.getAllByTitle("Close tab")[0]);
  expect(props.onTabClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.getByRole("textbox", { name: "Editor" })).toBeTruthy();
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getAllByTitle("Close tab")[0]);
  expect(props.onTabClose).toHaveBeenCalledWith("a.txt");
});

it("retains annotations across navigation and treats a new stroke after saving as dirty", async () => {
  const props = panelProps("a.png");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.spyOn(window, "Image").mockImplementation(function Image() {
    const image = { naturalWidth: 100, naturalHeight: 100, onload: null as (() => void) | null, onerror: null };
    Object.defineProperty(image, "src", { set: () => { queueMicrotask(() => image.onload?.()); } });
    return image as unknown as HTMLImageElement;
  } as unknown as typeof Image);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["image"])));
  const { container, rerender } = render(<FilePreviewPanel {...props} />);
  await act(async () => { fireEvent.click(screen.getByTitle("Annotate with red marker")); });
  const canvas = container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
  fireEvent.mouseUp(canvas);
  expect(screen.getByText("1 stroke")).toBeTruthy();
  rerender(<FilePreviewPanel {...props} showNotebook />);
  rerender(<FilePreviewPanel {...props} />);
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(screen.getByText("1 stroke")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
  expect(props.onSaveImageBlob).toHaveBeenCalledWith("a.png", expect.any(Blob));
  fireEvent.mouseDown(canvas, { clientX: 20, clientY: 20 });
  fireEvent.mouseUp(canvas);
  fireEvent.click(screen.getAllByTitle("Close tab")[0]);
  expect(confirm).toHaveBeenCalled();
  expect(props.onTabClose).not.toHaveBeenCalled();
});
