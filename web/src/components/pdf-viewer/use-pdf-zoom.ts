import { useCallback, useEffect, useState, type RefObject } from "react";

/** Fit stays responsive to pane resizing; a manual zoom explicitly leaves it. */
export function usePdfZoom(container: RefObject<HTMLDivElement | null>, pageWidth: number, initialFitWidth: boolean) {
  const [manualZoom, setManualZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(initialFitWidth);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      // Source-only mode hides the pane. Retain its scale until visible again.
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [container]);
  const zoom = fitWidth && width > 0 && pageWidth > 0
    ? Math.max(0.1, Math.min(4, (width - 24) / pageWidth))
    : manualZoom;
  const setZoom = useCallback((value: number) => {
    setFitWidth(false);
    setManualZoom(value);
  }, []);
  return { zoom, setZoom, fitWidth, fitToWidth: () => setFitWidth(true) };
}
