import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfZoom } from "./use-pdf-zoom";

afterEach(() => vi.unstubAllGlobals());

it("fits on resize, retains scale when hidden, and respects manual zoom until fit is selected again", () => {
  let resize!: () => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const el = document.createElement("div");
  let width = 524;
  Object.defineProperty(el, "clientWidth", { get: () => width });
  const ref = { current: el };
  const { result } = renderHook(() => usePdfZoom(ref, 1000, true));
  expect(result.current.zoom).toBe(0.5);
  act(() => { width = 824; resize(); });
  expect(result.current.zoom).toBe(0.8);
  act(() => { width = 0; resize(); });
  expect(result.current.zoom).toBe(0.8);
  act(() => result.current.setZoom(1.2));
  act(() => { width = 624; resize(); });
  expect(result.current.zoom).toBe(1.2);
  expect(result.current.fitWidth).toBe(false);
  act(() => result.current.fitToWidth());
  expect(result.current.zoom).toBe(0.6);
});
