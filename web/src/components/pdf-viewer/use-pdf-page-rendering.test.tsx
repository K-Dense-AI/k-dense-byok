import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePdfPageRendering } from "./use-pdf-page-rendering";

let observer: IntersectionObserverCallback;
let element: Element;
const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const text = vi.fn(async () => ({ items: [] }));
const updateText = vi.fn();
const page = {
  getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale, scale, convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale] }),
  render: renderPage, getTextContent: text, cleanup: vi.fn(),
};
const doc = { getPage: vi.fn(async () => page) } as unknown as PDFDocumentProxy;
const load = vi.fn(async () => ({ TextLayer: class {
  container: HTMLElement;
  constructor({ container }: { container: HTMLElement }) { this.container = container; }
  async render() { this.container.textContent = "Selectable PDF text"; }
  update = updateText;
  cancel() {}
} })) as unknown as Parameters<typeof usePdfPageRendering>[3];
function Harness({ scale = 1 }: { scale?: number }) {
  const view = usePdfPageRendering(doc, 1, scale, load);
  return <div data-pdf-scroll><div data-testid="page" ref={view.pageRef} style={{ height: view.size?.h }}>
    <canvas data-testid="canvas" ref={view.canvasRef} />
    <div ref={view.textLayerRef} /><span>Annotation stays mounted</span>
  </div></div>;
}
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe(target: Element) { element = target; }
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {} } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const visibility = (value: boolean) => act(() => observer([{ target: element, isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver));

describe("PDF canvas residency", () => {
  it("evicts pixels, keeps selection/annotations/layout, and lazily redraws on return", async () => {
    const { rerender } = render(<Harness />);
    await screen.findByText("Selectable PDF text");
    const canvas = screen.getByTestId("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(0);
    visibility(false);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(screen.getByText("Selectable PDF text")).toBeInTheDocument();
    expect(screen.getByText("Annotation stays mounted")).toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveStyle({ height: "200px" });
    const count = renderPage.mock.calls.length;
    rerender(<Harness scale={2} />);
    expect(renderPage).toHaveBeenCalledTimes(count);
    expect(screen.getByTestId("page")).toHaveStyle({ height: "400px" });
    expect(updateText).toHaveBeenCalled();
    visibility(true);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(count + 1));
    expect(canvas.width).toBeGreaterThan(0);
    expect(text).toHaveBeenCalledTimes(1);
  });
});
