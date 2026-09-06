"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, TextLayer } from "pdfjs-dist";

type PdfjsModule = typeof import("pdfjs-dist");

/** Keep text/geometry for selection and links; only canvases are evictable. */
export function usePdfPageRendering(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  loadPdfjs: () => Promise<PdfjsModule>,
) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(pageNumber <= 2);
  const [loaded, setLoaded] = useState<{ doc: PDFDocumentProxy; page: PDFPageProxy } | null>(null);
  const page = loaded?.doc === doc ? loaded.page : null;
  const viewport = useMemo(() => page?.getViewport({ scale }) ?? null, [page, scale]);
  const latestViewport = useRef(viewport);
  latestViewport.current = viewport;
  const layerRef = useRef<TextLayer | null>(null);

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === el) setNearby(entry.isIntersecting);
    }, { root: el.closest("[data-pdf-scroll]"), rootMargin: "100% 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearby || page) return;
    let cancelled = false;
    void doc.getPage(pageNumber).then((next) => {
      if (!cancelled) setLoaded({ doc, page: next });
    }).catch(() => {}); // Document may have been destroyed during reload.
    return () => { cancelled = true; };
  }, [doc, pageNumber, nearby, page]);

  useEffect(() => {
    if (pageRef.current && viewport) {
      // Annotation and SyncTeX hit-testing use the same transform, including
      // off-screen visited pages after a zoom change.
      Object.assign(pageRef.current, { __pdfViewport: viewport });
    }
    if (textLayerRef.current && viewport) {
      textLayerRef.current.style.width = `${viewport.width}px`;
      textLayerRef.current.style.height = `${viewport.height}px`;
      layerRef.current?.update({ viewport });
    }
  }, [viewport]);

  useEffect(() => {
    const container = textLayerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!page) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    void (async () => {
      const [pdfjs, text] = await Promise.all([loadPdfjs(), page.getTextContent()]);
      if (cancelled || !latestViewport.current) return;
      layer = new pdfjs.TextLayer({ textContentSource: text, container, viewport: latestViewport.current });
      layerRef.current = layer;
      await layer.render();
      if (!cancelled && latestViewport.current) layer.update({ viewport: latestViewport.current });
    })().catch(() => {}); // Text extraction remains best effort.
    return () => {
      cancelled = true;
      layer?.cancel();
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, [page, loadPdfjs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!nearby || !page || !viewport) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const task = page.render({ canvas, canvasContext: context, viewport });
    void task.promise.catch(() => {});
    return () => {
      task.cancel();
      // Release backing pixels, not the page's text/annotations or layout.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    };
  }, [page, viewport, nearby]);

  return {
    pageRef, canvasRef, textLayerRef, viewport,
    size: viewport ? { w: viewport.width, h: viewport.height } : null,
  };
}
