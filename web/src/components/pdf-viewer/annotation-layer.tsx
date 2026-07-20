"use client";

/**
 * Per-page annotation overlay.
 *
 * Consumes the pdfjs viewport so we can transform PDF-space rectangles
 * (y-up, page-local) into CSS-space rectangles (y-down, top-left origin)
 * at the current zoom. Highlights render as translucent divs; notes
 * render as small circular pins.
 */

import { useMemo, useState } from "react";

import {
  type Annotation,
  type Author,
  type HighlightAnnotation,
  type NoteAnnotation,
} from "@/lib/pdf-annotations";
import { cn } from "@/lib/utils";

import type { PdfjsViewport } from "./pdf-viewer";
import { NotePopover } from "./note-popover";

export interface AnnotationLayerProps {
  width: number;
  height: number;
  annotations: Annotation[];
  activeAnnotationId: string | null;
  viewport: PdfjsViewport | null;
  colorForAuthor: (a: Author) => string;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Annotation>) => void;
}

export function AnnotationLayer({
  width,
  height,
  annotations,
  activeAnnotationId,
  viewport,
  colorForAuthor,
  onRemove,
  onUpdate,
}: AnnotationLayerProps) {
  const [openNote, setOpenNote] = useState<{
    id: string;
    screen: { x: number; y: number };
  } | null>(null);

  const { highlights, notes } = useMemo(() => {
    const h: HighlightAnnotation[] = [];
    const n: NoteAnnotation[] = [];
    for (const a of annotations) {
      if (a.type === "highlight") h.push(a);
      else n.push(a);
    }
    return { highlights: h, notes: n };
  }, [annotations]);

  if (!viewport) {
    return <div className="pointer-events-none absolute inset-0" />;
  }

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ width, height }}
    >
      {/* Highlights: rendered beneath pins, click-to-open. Use
          mix-blend-multiply so we tint the underlying canvas instead
          of covering text. */}
      {highlights.map((h) => {
        const color = h.color || colorForAuthor(h.author);
        const label = h.author.label;
        return (
          <div key={h.id} className="absolute inset-0 pointer-events-none">
            {h.rects.map((r, i) => {
              const css = rectToCss(viewport, r);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenNote({
                      id: h.id,
                      screen: { x: e.clientX, y: e.clientY },
                    });
                  }}
                  title={`${label}${h.note ? ": " + h.note : ""}`}
                  className={cn(
                    "absolute pointer-events-auto cursor-pointer",
                    activeAnnotationId === h.id && "ring-2 ring-offset-1 ring-primary animate-pulse",
                  )}
                  style={{
                    left: css.left,
                    top: css.top,
                    width: css.width,
                    height: css.height,
                    backgroundColor: color,
                    opacity: 0.45,
                    mixBlendMode: "multiply",
                  }}
                />
              );
            })}
          </div>
        );
      })}

      {/* Sticky-note pins */}
      {notes.map((n) => {
        const color = n.color || colorForAuthor(n.author);
        const pos = pointToCss(viewport, n.anchor);
        return (
          <button
            key={n.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpenNote({
                id: n.id,
                screen: { x: e.clientX, y: e.clientY },
              });
            }}
            title={`${n.author.label}: ${n.body.slice(0, 60)}${n.body.length > 60 ? "…" : ""}`}
            className={cn(
              "absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-foreground/30 shadow text-[10px] font-semibold text-foreground",
              activeAnnotationId === n.id && "ring-2 ring-offset-1 ring-primary animate-pulse",
            )}
            style={{
              left: pos.left,
              top: pos.top,
              backgroundColor: color,
            }}
          >
            {n.author.kind === "expert" ? "AI" : "✎"}
          </button>
        );
      })}

      {openNote &&
        (() => {
          const ann = annotations.find((a) => a.id === openNote.id);
          if (!ann) return null;
          const initial =
            ann.type === "note" ? ann.body : (ann.note ?? "");
          return (
            <NotePopover
              screen={openNote.screen}
              initialBody={initial}
              author={ann.author}
              showDelete
              onCancel={() => setOpenNote(null)}
              onSave={(body) => {
                if (ann.type === "note") {
                  onUpdate(ann.id, { body } as Partial<Annotation>);
                } else {
                  onUpdate(ann.id, { note: body } as Partial<Annotation>);
                }
                setOpenNote(null);
              }}
              onDelete={(force) => {
                // Expert annotations are protected behind Alt/force.
                if (ann.author.kind === "expert" && !force) return;
                onRemove(ann.id);
                setOpenNote(null);
              }}
              isExpert={ann.author.kind === "expert"}
            />
          );
        })()}
    </div>
  );
}

function rectToCss(
  viewport: PdfjsViewport,
  r: { x: number; y: number; w: number; h: number },
): { left: number; top: number; width: number; height: number } {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
    r.x,
    r.y,
    r.x + r.w,
    r.y + r.h,
  ]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { left, top, width, height };
}

function pointToCss(
  viewport: PdfjsViewport,
  p: { x: number; y: number },
): { left: number; top: number } {
  // convertToViewportRectangle handles the y-flip for us; use a zero-size
  // rect at the anchor point.
  const [x, y] = viewport.convertToViewportRectangle([p.x, p.y, p.x, p.y]);
  return { left: x, top: y };
}
