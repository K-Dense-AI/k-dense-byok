import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HighlightAnnotation } from "@/lib/pdf-annotations";

import { AnnotationLayer } from "./annotation-layer";
import type { PdfjsViewport } from "./pdf-viewer";

const viewport: PdfjsViewport = {
  width: 600,
  height: 800,
  convertToPdfPoint: (x, y) => [x, y],
  convertToViewportRectangle: ([x1, y1, x2, y2]) => [x1, y1, x2, y2],
};

const highlight: HighlightAnnotation = {
  id: "highlight-1",
  type: "highlight",
  page: 1,
  rects: [{ x: 10, y: 20, w: 100, h: 12 }],
  text: "Selected passage",
  color: "#fde68a",
  author: { kind: "user", id: "local", label: "You" },
  createdAt: "2026-07-20T00:00:00.000Z",
};

describe("AnnotationLayer", () => {
  it("lets pointer gestures reach the PDF text layer while annotations remain interactive", () => {
    const { container } = render(
      <AnnotationLayer
        width={600}
        height={800}
        annotations={[highlight]}
        activeAnnotationId={null}
        viewport={viewport}
        colorForAuthor={() => "#fde68a"}
        onRemove={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(container.firstElementChild).toHaveClass("pointer-events-none");
    const highlightButton = container.querySelector("button");
    expect(highlightButton).toHaveClass("pointer-events-auto");

    fireEvent.click(highlightButton!);
    expect(screen.getByRole("textbox").parentElement).toHaveClass(
      "pointer-events-auto",
    );
  });
});
