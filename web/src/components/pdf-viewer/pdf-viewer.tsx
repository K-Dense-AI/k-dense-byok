"use client";

/**
 * Custom PDF viewer built on pdfjs-dist with a per-page annotation overlay.
 *
 * Architecture:
 *   - Dynamically imports pdfjs-dist on the client (it doesn't SSR well).
 *   - Renders each page as a <canvas> with pdfjs's text layer on top,
 *     then stacks an absolute-positioned <AnnotationLayer> per page for
 *     highlights and note pins.
 *   - Annotations are stored in PDF user-space points (y-up, page-local)
 *     and converted to CSS pixels via the page viewport transform, so
 *     they stay aligned when zoom changes.
 *   - State is persisted to <file>.pdf.annotations.json via the endpoints
 *     in pdf-annotations.ts, and polled for external writes (e.g. the
 *     expert-side MCP dropping its own annotations mid-delegation).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { rawFileUrl } from "@/lib/use-sandbox";
import {
  type Annotation,
  type AnnotationsDoc,
  type Author,
  type HighlightAnnotation,
  type NoteAnnotation,
  type Rect,
  EMPTY_DOC,
  USER_AUTHOR,
  USER_COLOR,
  colorForAuthor,
  fetchAnnotations,
  newAnnotationId,
  saveAnnotations,
  subscribeAnnotations,
} from "@/lib/pdf-annotations";
import { cn } from "@/lib/utils";

import { AnnotationLayer } from "./annotation-layer";
import { AnnotationSidebar } from "./annotation-sidebar";
import { NotePopover } from "./note-popover";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;
type PdfPage = import("pdfjs-dist").PDFPageProxy;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

// pdfjs-dist 5.6+ uses `Map.prototype.getOrInsertComputed`, a TC39 stage-2
// proposal (`upsert`) not yet shipped in Chrome/Electron versions we target.
// Polyfill before loading the library to avoid "is not a function" at
// document open time.
function installMapUpsertPolyfill(): void {
  type UpsertMap = Map<unknown, unknown> & {
    getOrInsertComputed?: (k: unknown, fn: (k: unknown) => unknown) => unknown;
    getOrInsert?: (k: unknown, v: unknown) => unknown;
  };
  const proto = Map.prototype as unknown as UpsertMap;
  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function (
      this: Map<unknown, unknown>,
      key: unknown,
      fn: (k: unknown) => unknown,
    ) {
      if (this.has(key)) return this.get(key);
      const v = fn(key);
      this.set(key, v);
      return v;
    };
  }
  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    };
  }
}

// Polyfill source as a string so we can prepend it to the worker before
// it evaluates the bundled pdfjs code.
const MAP_UPSERT_POLYFILL_SRC = `
(function(){
  var p = Map.prototype;
  if (typeof p.getOrInsertComputed !== 'function') {
    p.getOrInsertComputed = function(k, fn){
      if (this.has(k)) return this.get(k);
      var v = fn(k); this.set(k, v); return v;
    };
  }
  if (typeof p.getOrInsert !== 'function') {
    p.getOrInsert = function(k, v){
      if (this.has(k)) return this.get(k);
      this.set(k, v); return v;
    };
  }
})();
`;

async function buildWorkerUrl(): Promise<string> {
  // Resolve bundled worker asset URL. Works with both Webpack and Turbopack.
  const realUrl = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  try {
    const src = await fetch(realUrl).then((r) => r.text());
    const patched = `${MAP_UPSERT_POLYFILL_SRC}\n${src}`;
    const blob = new Blob([patched], { type: "text/javascript" });
    return URL.createObjectURL(blob);
  } catch {
    return realUrl;
  }
}

function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    installMapUpsertPolyfill();
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = await buildWorkerUrl();
    return pdfjs;
  })();
  return pdfjsPromise;
}

// Rendering scale — multiplied by zoom. 1.5 gives us a crisp canvas at
// 100% zoom; we set devicePixelRatio separately on the canvas.
const BASE_SCALE = 1.5;

export interface PdfSyncHighlight {
  page: number;
  h: number;
  v: number;
  W: number;
  H: number;
  token: number;
}
export interface PdfSyncClick {
  page: number;
  x: number;
  y: number;
} // top-left PDF points
export interface PdfViewerProps {
  path: string;
  className?: string;
  reloadToken?: number; // bump to re-fetch the same path in place (scroll/zoom preserved)
  syncHighlight?: PdfSyncHighlight | null; // scroll to + flash this box (synctex view coords)
  onSyncClick?: (pos: PdfSyncClick) => void; // Cmd/Ctrl+click on a page
  hideAnnotationUi?: boolean; // hide annotation sidebar + highlight/note buttons
}

export function PdfViewer({
  path,
  className,
  reloadToken = 0,
  syncHighlight = null,
  onSyncClick,
  hideAnnotationUi = false,
}: PdfViewerProps) {
  const [pdfjs, setPdfjs] = useState<PdfjsModule | null>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const [annotations, setAnnotations] =
    useState<AnnotationsDoc>(EMPTY_DOC);
  const [lastModified, setLastModified] = useState<string | null>(null);
  const annotationsRef = useRef<AnnotationsDoc>(EMPTY_DOC);
  const lastModifiedRef = useRef<string | null>(null);
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);
  useEffect(() => {
    lastModifiedRef.current = lastModified;
  }, [lastModified]);

  const [mode, setMode] = useState<"none" | "highlight" | "note">("none");
  const [showExpert, setShowExpert] = useState(true);
  const [activeAnnotationId, setActiveAnnotationId] =
    useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<{
    page: number;
    anchor: { x: number; y: number };
    screen: { x: number; y: number };
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const docRef = useRef<PdfDoc | null>(null);
  const loadedPathRef = useRef<string | null>(null);

  // --------------------------------------------------------------------
  // Load pdfjs + document
  // --------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    loadPdfjs()
      .then((mod) => {
        if (!cancelled) setPdfjs(mod);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load PDF engine");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pdfjs) return;
    let cancelled = false;
    // Reload-in-place: same path with a doc already shown keeps the old
    // canvases up until the new document is ready, then restores scroll.
    const isReload = docRef.current !== null && loadedPathRef.current === path;
    const savedScroll = isReload ? (containerRef.current?.scrollTop ?? null) : null;
    const url = rawFileUrl(path) + (reloadToken ? `&_r=${reloadToken}` : "");
    const task = pdfjs.getDocument({ url, withCredentials: true });
    if (!isReload) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setError(null);
        setDoc(null);
        setNumPages(0);
      });
    }
    task.promise.then(
      (loaded) => {
        if (cancelled) {
          loaded.destroy();
          return;
        }
        const prev = docRef.current;
        docRef.current = loaded;
        loadedPathRef.current = path;
        setError(null);
        setDoc(loaded);
        setNumPages(loaded.numPages);
        if (prev && prev !== loaded) {
          try { prev.destroy(); } catch { /* already gone */ }
        }
        if (savedScroll !== null) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (containerRef.current) containerRef.current.scrollTop = savedScroll;
            });
          });
        }
      },
      (e) => {
        if (!cancelled) {
          // Release a previously-successful doc's transport now rather
          // than leaving it dangling until unmount.
          try { docRef.current?.destroy(); } catch { /* ignore */ }
          docRef.current = null;
          setError(e?.message ?? "Failed to load PDF");
        }
      },
    );
    return () => {
      cancelled = true;
      // Only tear down a load that never became the displayed document —
      // destroying the live doc mid-reload would break mounted PageViews.
      task.promise.then(
        (loaded) => {
          if (loaded !== docRef.current) {
            try { loaded.destroy(); } catch { /* ignore */ }
          }
        },
        () => {},
      );
    };
  }, [pdfjs, path, reloadToken]);

  useEffect(
    () => () => {
      try { docRef.current?.destroy(); } catch { /* ignore */ }
      docRef.current = null;
    },
    [],
  );

  // --------------------------------------------------------------------
  // Annotations fetch + polling
  // --------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    fetchAnnotations(path).then((res) => {
      if (cancelled) return;
      setAnnotations(res.doc);
      setLastModified(res.lastModified);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const unsub = subscribeAnnotations(
      path,
      lastModifiedRef.current,
      ({ doc: newDoc, lastModified: newMtime }) => {
        setAnnotations(newDoc);
        setLastModified(newMtime);
      },
    );
    return unsub;
  }, [path]);

  // --------------------------------------------------------------------
  // Persistence (debounced per keystroke is overkill — we save on every
  // annotation mutation and rely on If-Unmodified-Since to avoid clobber)
  // --------------------------------------------------------------------

  const persist = useCallback(
    async (next: AnnotationsDoc) => {
      const res = await saveAnnotations(
        path,
        next,
        lastModifiedRef.current,
      );
      if (res.conflict) {
        const fresh = await fetchAnnotations(path);
        // Merge: start from disk, then re-apply our local changes that
        // aren't present there (by id). Disk wins on id collisions.
        const byId = new Map<string, Annotation>();
        for (const a of fresh.doc.annotations) byId.set(a.id, a);
        for (const a of next.annotations) {
          if (!byId.has(a.id)) byId.set(a.id, a);
        }
        const merged: AnnotationsDoc = {
          version: 1,
          annotations: Array.from(byId.values()),
        };
        setAnnotations(merged);
        setLastModified(fresh.lastModified);
        const retry = await saveAnnotations(
          path,
          merged,
          fresh.lastModified,
        );
        if (retry.ok) setLastModified(retry.lastModified);
        return;
      }
      if (res.ok) setLastModified(res.lastModified);
    },
    [path],
  );

  const mutate = useCallback(
    (updater: (prev: AnnotationsDoc) => AnnotationsDoc) => {
      setAnnotations((prev) => {
        const next = updater(prev);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const addAnnotation = useCallback(
    (ann: Annotation) => {
      mutate((prev) => ({
        version: 1,
        annotations: [...prev.annotations, ann],
      }));
    },
    [mutate],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      mutate((prev) => ({
        version: 1,
        annotations: prev.annotations.filter((a) => a.id !== id),
      }));
    },
    [mutate],
  );

  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Annotation>) => {
      mutate((prev) => ({
        version: 1,
        annotations: prev.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      }));
    },
    [mutate],
  );

  // --------------------------------------------------------------------
  // Highlight from current text selection
  // --------------------------------------------------------------------

  const handleHighlightSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    // Find the page each selection rect belongs to, using the
    // data-page attribute on each page wrapper.
    const pageEls = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-pdf-page]",
      ) ?? [],
    );
    if (!pageEls.length) return;

    // Group rects by page.
    const byPage = new Map<
      HTMLElement,
      { rects: DOMRect[]; page: number }
    >();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      for (const el of pageEls) {
        const box = el.getBoundingClientRect();
        if (
          midX >= box.left &&
          midX <= box.right &&
          midY >= box.top &&
          midY <= box.bottom
        ) {
          const page = Number(el.dataset.pdfPage);
          if (!byPage.has(el))
            byPage.set(el, { rects: [], page });
          byPage.get(el)!.rects.push(rect);
          break;
        }
      }
    }

    const text = sel.toString().trim();
    const createdAt = new Date().toISOString();

    for (const [el, { rects, page }] of byPage) {
      const pageBox = el.getBoundingClientRect();
      const viewport = readViewport(el);
      if (!viewport) continue;
      const pdfRects: Rect[] = rects.map((r) => {
        // CSS-space rect relative to page box, then to PDF-space.
        const x1 = r.left - pageBox.left;
        const y1 = r.top - pageBox.top;
        const x2 = r.right - pageBox.left;
        const y2 = r.bottom - pageBox.top;
        const [px1, py1] = viewport.convertToPdfPoint(x1, y1);
        const [px2, py2] = viewport.convertToPdfPoint(x2, y2);
        const x = Math.min(px1, px2);
        const y = Math.min(py1, py2);
        const w = Math.abs(px2 - px1);
        const h = Math.abs(py2 - py1);
        return { x, y, w, h };
      });
      if (!pdfRects.length) continue;
      const ann: HighlightAnnotation = {
        id: newAnnotationId(),
        type: "highlight",
        page,
        rects: pdfRects,
        text,
        color: USER_COLOR,
        author: USER_AUTHOR,
        createdAt,
      };
      addAnnotation(ann);
    }

    sel.removeAllRanges();
    setMode("none");
  }, [addAnnotation]);

  // --------------------------------------------------------------------
  // Drop-a-note interaction
  // --------------------------------------------------------------------

  const handlePageClick = useCallback(
    (ev: React.MouseEvent<HTMLDivElement>, page: number) => {
      if ((ev.metaKey || ev.ctrlKey) && onSyncClick) {
        const pageBox = ev.currentTarget.getBoundingClientRect();
        const s = BASE_SCALE * zoom;
        onSyncClick({
          page,
          x: (ev.clientX - pageBox.left) / s,
          y: (ev.clientY - pageBox.top) / s,
        });
        return;
      }
      if (mode !== "note") return;
      const el = ev.currentTarget;
      const box = el.getBoundingClientRect();
      const cssX = ev.clientX - box.left;
      const cssY = ev.clientY - box.top;
      const viewport = readViewport(el);
      if (!viewport) return;
      const [x, y] = viewport.convertToPdfPoint(cssX, cssY);
      setPendingNote({
        page,
        anchor: { x, y },
        screen: { x: ev.clientX, y: ev.clientY },
      });
      setMode("none");
    },
    [mode, onSyncClick, zoom],
  );

  // --------------------------------------------------------------------
  // Filtered view for the layers + sidebar
  // --------------------------------------------------------------------

  const visibleAnnotations = useMemo(
    () =>
      annotations.annotations.filter(
        (a) => showExpert || a.author.kind !== "expert",
      ),
    [annotations, showExpert],
  );

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of visibleAnnotations) {
      if (!map.has(a.page)) map.set(a.page, []);
      map.get(a.page)!.push(a);
    }
    return map;
  }, [visibleAnnotations]);

  const jumpToAnnotation = useCallback((ann: Annotation) => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-pdf-page="${ann.page}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveAnnotationId(ann.id);
    setTimeout(() => setActiveAnnotationId(null), 1500);
  }, []);

  useEffect(() => {
    if (!syncHighlight) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-pdf-page="${syncHighlight.page}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncHighlight?.token]);

  // --------------------------------------------------------------------
  // Default page size (from page 1) — gates lazy page rendering so
  // off-screen pages can reserve their layout space before they render.
  // --------------------------------------------------------------------

  const [defaultSize, setDefaultSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc
      .getPage(1)
      .then((p: PdfPage) => {
        if (cancelled) return;
        const vp = p.getViewport({ scale: BASE_SCALE * zoom });
        setDefaultSize({ w: vp.width, h: vp.height });
      })
      .catch(() => {
        // getPage(1) failed — fall back to a US-Letter-shaped size so
        // pages still attempt to render instead of the viewer going
        // permanently blank (defaultSize gates the whole page list).
        if (!cancelled) {
          setDefaultSize({ w: 612 * BASE_SCALE * zoom, h: 792 * BASE_SCALE * zoom });
        }
      });
    return () => { cancelled = true; };
  }, [doc, zoom]);

  // --------------------------------------------------------------------
  // Track current page for the toolbar
  // --------------------------------------------------------------------

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              (b.intersectionRatio ?? 0) - (a.intersectionRatio ?? 0),
          );
        if (visible.length) {
          const page = Number(
            (visible[0].target as HTMLElement).dataset.pdfPage,
          );
          if (page) setCurrentPage(page);
        }
      },
      { root: c, threshold: [0.25, 0.5, 0.75] },
    );
    const pages = c.querySelectorAll("[data-pdf-page]");
    pages.forEach((p) => observer.observe(p));
    return () => observer.disconnect();
  }, [numPages, defaultSize]);

  // --------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <Toolbar
        currentPage={currentPage}
        numPages={numPages}
        zoom={zoom}
        setZoom={setZoom}
        mode={mode}
        setMode={setMode}
        onCommitHighlight={handleHighlightSelection}
        showExpert={showExpert}
        setShowExpert={setShowExpert}
        hideAnnotationUi={hideAnnotationUi}
        onJumpPage={(p) => {
          const el = containerRef.current?.querySelector<HTMLElement>(
            `[data-pdf-page="${p}"]`,
          );
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <div className="flex flex-1 min-h-0">
        <div
          ref={containerRef}
          className={cn(
            "flex-1 overflow-auto bg-muted/30",
            mode === "note" && "cursor-crosshair",
          )}
        >
          <div className="mx-auto flex flex-col items-center gap-3 py-3">
            {doc && defaultSize &&
              Array.from({ length: numPages }, (_, i) => i + 1).map(
                (pageNumber) => (
                  <PageView
                    key={pageNumber}
                    doc={doc}
                    pageNumber={pageNumber}
                    zoom={zoom}
                    defaultSize={defaultSize}
                    sync={syncHighlight?.page === pageNumber ? syncHighlight : null}
                    annotations={
                      annotationsByPage.get(pageNumber) ?? []
                    }
                    activeAnnotationId={activeAnnotationId}
                    onRemove={removeAnnotation}
                    onUpdate={updateAnnotation}
                    onClickPage={(e) => handlePageClick(e, pageNumber)}
                  />
                ),
              )}
            {!doc && (
              <div className="py-10 text-sm text-muted-foreground">
                Loading PDF…
              </div>
            )}
          </div>
        </div>

        {!hideAnnotationUi && (
          <AnnotationSidebar
            annotations={visibleAnnotations}
            onJump={jumpToAnnotation}
            onRemove={removeAnnotation}
          />
        )}
      </div>

      {pendingNote && (
        <NotePopover
          screen={pendingNote.screen}
          initialBody=""
          author={USER_AUTHOR}
          onCancel={() => setPendingNote(null)}
          onSave={(body) => {
            const ann: NoteAnnotation = {
              id: newAnnotationId(),
              type: "note",
              page: pendingNote.page,
              anchor: pendingNote.anchor,
              body,
              color: USER_COLOR,
              author: USER_AUTHOR,
              createdAt: new Date().toISOString(),
            };
            addAnnotation(ann);
            setPendingNote(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function Toolbar({
  currentPage,
  numPages,
  zoom,
  setZoom,
  mode,
  setMode,
  onCommitHighlight,
  showExpert,
  setShowExpert,
  hideAnnotationUi,
  onJumpPage,
}: {
  currentPage: number;
  numPages: number;
  zoom: number;
  setZoom: (z: number) => void;
  mode: "none" | "highlight" | "note";
  setMode: (m: "none" | "highlight" | "note") => void;
  onCommitHighlight: () => void;
  showExpert: boolean;
  setShowExpert: (v: boolean) => void;
  hideAnnotationUi: boolean;
  onJumpPage: (p: number) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background/60 px-2 py-1 text-xs">
      <button
        className="rounded px-2 py-1 hover:bg-muted"
        title="Zoom out"
        onClick={() => setZoom(Math.max(0.4, +(zoom - 0.1).toFixed(2)))}
      >
        −
      </button>
      <span className="w-12 text-center tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <button
        className="rounded px-2 py-1 hover:bg-muted"
        title="Zoom in"
        onClick={() => setZoom(Math.min(4, +(zoom + 0.1).toFixed(2)))}
      >
        +
      </button>
      <button
        className="rounded px-2 py-1 hover:bg-muted"
        onClick={() => setZoom(1)}
        title="Fit 100%"
      >
        100%
      </button>

      <div className="mx-2 h-4 w-px bg-border" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(
            (e.currentTarget.elements.namedItem("p") as HTMLInputElement)
              .value,
          );
          if (v >= 1 && v <= numPages) onJumpPage(v);
        }}
        className="flex items-center gap-1"
      >
        Page
        <input
          name="p"
          defaultValue={currentPage}
          key={currentPage}
          className="w-10 rounded border bg-transparent px-1 py-0.5 text-center tabular-nums"
        />
        / <span className="tabular-nums">{numPages}</span>
      </form>

      <div className="mx-2 h-4 w-px bg-border" />

      {!hideAnnotationUi && (
        <button
          className={cn(
            "rounded px-2 py-1",
            mode === "highlight" ? "bg-amber-200 text-amber-900" : "hover:bg-muted",
          )}
          title="Highlight current text selection"
          onClick={() => {
            setMode("highlight");
            onCommitHighlight();
          }}
        >
          Highlight selection
        </button>
      )}
      {!hideAnnotationUi && (
        <button
          className={cn(
            "rounded px-2 py-1",
            mode === "note" ? "bg-blue-200 text-blue-900" : "hover:bg-muted",
          )}
          title="Click on the page to drop a note"
          onClick={() => setMode(mode === "note" ? "none" : "note")}
        >
          {mode === "note" ? "Click page…" : "Add note"}
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {!hideAnnotationUi && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showExpert}
              onChange={(e) => setShowExpert(e.target.checked)}
            />
            Expert annotations
          </label>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-page renderer: canvas + text layer + annotation layer
// ---------------------------------------------------------------------------

function PageView({
  doc,
  pageNumber,
  zoom,
  defaultSize,
  sync,
  annotations,
  activeAnnotationId,
  onRemove,
  onUpdate,
  onClickPage,
}: {
  doc: PdfDoc;
  pageNumber: number;
  zoom: number;
  defaultSize: { w: number; h: number } | null;
  sync: { h: number; v: number; W: number; H: number; token: number } | null;
  annotations: Annotation[];
  activeAnnotationId: string | null;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Annotation>) => void;
  onClickPage: (ev: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState<PdfjsViewport | null>(null);

  const [visible, setVisible] = useState(pageNumber <= 2);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || visible) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "150% 0%" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    (async () => {
      let page: PdfPage;
      try {
        page = await doc.getPage(pageNumber);
      } catch {
        // Doc was likely destroyed mid-reload ("Transport destroyed") —
        // bail silently, same as the cancellation path below.
        return;
      }
      if (cancelled) return;

      const scale = BASE_SCALE * zoom;
      const rawViewport = page.getViewport({ scale });
      const viewport = rawViewport as unknown as PdfjsViewport;
      if (pageRef.current) {
        stashViewport(pageRef.current, viewport);
      }
      setViewport(viewport);

      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ w: viewport.width, h: viewport.height });

      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const rp = page.render({
        canvasContext: ctx,
        viewport,
        canvas,
      } as unknown as Parameters<PdfPage["render"]>[0]);
      renderTask = rp as unknown as { cancel: () => void };
      try {
        await rp.promise;
      } catch {
        // cancelled
        return;
      }

      // Build the text layer. pdfjs 5.x exposes `TextLayer` from the
      // top-level module; fall back to the classic API when unavailable.
      textLayer.innerHTML = "";
      textLayer.style.width = `${viewport.width}px`;
      textLayer.style.height = `${viewport.height}px`;
      try {
        const pdfjs = await loadPdfjs();
        const textContent = await page.getTextContent();
        const TextLayerCtor = (pdfjs as unknown as {
          TextLayer?: new (opts: {
            textContentSource: unknown;
            container: HTMLElement;
            viewport: unknown;
          }) => { render: () => Promise<void> };
        }).TextLayer;
        if (TextLayerCtor) {
          const layer = new TextLayerCtor({
            textContentSource: textContent,
            container: textLayer,
            viewport,
          });
          await layer.render();
        } else {
          // Classic path on older builds
          const render = (pdfjs as unknown as {
            renderTextLayer?: (opts: {
              textContent: unknown;
              container: HTMLElement;
              viewport: unknown;
              textDivs: HTMLElement[];
            }) => { promise: Promise<void> };
          }).renderTextLayer;
          if (render) {
            const task = render({
              textContent,
              container: textLayer,
              viewport,
              textDivs: [],
            });
            await task.promise;
          }
        }
      } catch {
        // text layer is best-effort
      }
    })();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [doc, pageNumber, zoom, visible]);

  return (
    <div
      ref={pageRef}
      data-pdf-page={pageNumber}
      onClick={onClickPage}
      className="relative shadow-md ring-1 ring-border bg-white"
      style={(size ?? defaultSize) ? { width: (size ?? defaultSize)!.w, height: (size ?? defaultSize)!.h } : undefined}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none select-none"
      />
      <div
        ref={textLayerRef}
        className="pdf-text-layer absolute inset-0"
      />
      {sync && (
        <div
          key={sync.token}
          className="pointer-events-none absolute z-10 animate-sync-flash rounded-sm bg-blue-400/40 ring-2 ring-blue-500"
          style={{
            left: sync.h * BASE_SCALE * zoom,
            top: (sync.v - sync.H) * BASE_SCALE * zoom,
            width: Math.max(sync.W * BASE_SCALE * zoom, 8),
            height: Math.max(sync.H * BASE_SCALE * zoom, 8),
          }}
        />
      )}
      {size && (
        <AnnotationLayer
          width={size.w}
          height={size.h}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          viewport={viewport}
          colorForAuthor={colorForAuthor}
          onRemove={onRemove}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface PdfjsViewport {
  width: number;
  height: number;
  convertToPdfPoint: (x: number, y: number) => [number, number];
  convertToViewportRectangle: (
    rect: [number, number, number, number],
  ) => [number, number, number, number];
}

type WithViewport = HTMLElement & { __pdfViewport?: PdfjsViewport };

function readViewport(el: HTMLElement): PdfjsViewport | null {
  // The React PageView stores the viewport via ref; the annotation layer
  // passes it through. For the highlight-from-selection path we dig it
  // off the element by walking the React fiber — too fragile. Instead we
  // stash it on the DOM node via a React effect (see AnnotationLayer).
  const stashed = (el as WithViewport).__pdfViewport;
  return stashed ?? null;
}

// Re-export helper used by annotation-layer to pin the viewport.
export function stashViewport(
  el: HTMLElement,
  viewport: PdfjsViewport,
): void {
  (el as WithViewport).__pdfViewport = viewport;
}

export { type Author };
