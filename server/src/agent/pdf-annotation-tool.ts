import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  mutatePdfAnnotations,
  readPdfAnnotations,
  type PdfAnnotation,
  type PdfAnnotationAuthor,
  type PdfAnnotationsDoc,
} from "../pdf-annotations-store.ts";
import { resolvePaths, touchProject } from "../projects.ts";

const PdfRectParams = Type.Object({
  x: Type.Number({ description: "Left edge in PDF points" }),
  y: Type.Number({ description: "Bottom edge in PDF points" }),
  w: Type.Number({ exclusiveMinimum: 0, description: "Width in PDF points" }),
  h: Type.Number({ exclusiveMinimum: 0, description: "Height in PDF points" }),
});

const PdfAnchorParams = Type.Object({
  x: Type.Number({ description: "Horizontal position in PDF points" }),
  y: Type.Number({ description: "Vertical position in PDF points" }),
});

export const AddPdfAnnotationParams = Type.Object({
  pdf_path: Type.String({
    minLength: 1,
    description: "Sandbox-relative path to an existing PDF",
  }),
  type: Type.Union([Type.Literal("highlight"), Type.Literal("note")]),
  page: Type.Integer({
    minimum: 1,
    description: "1-indexed PDF page number",
  }),
  text: Type.Optional(
    Type.String({
      description: "Exact selected text (required for highlights)",
    }),
  ),
  rects: Type.Optional(
    Type.Array(PdfRectParams, {
      minItems: 1,
      maxItems: 100,
      description:
        "Highlight rectangles in PDF user-space points (origin bottom-left, y upward)",
    }),
  ),
  note: Type.Optional(
    Type.String({
      maxLength: 4000,
      description: "Short optional comment attached to a highlight",
    }),
  ),
  anchor: Type.Optional(
    PdfAnchorParams,
  ),
  body: Type.Optional(
    Type.String({
      maxLength: 4000,
      description: "Short note body (required for notes)",
    }),
  ),
  color: Type.Optional(
    Type.String({
      pattern: "^#[0-9A-Fa-f]{6}$",
      description: "Optional #RRGGBB color; omit for the expert palette",
    }),
  ),
});

export const ListPdfAnnotationsParams = Type.Object({
  pdf_path: Type.String({
    minLength: 1,
    description: "Sandbox-relative path to an existing PDF",
  }),
  author_kind: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("expert")]),
  ),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const RemovePdfAnnotationParams = Type.Object({
  pdf_path: Type.String({
    minLength: 1,
    description: "Sandbox-relative path to an existing PDF",
  }),
  annotation_id: Type.String({
    minLength: 1,
    description: "Annotation id returned by add/list",
  }),
});

export type AddPdfAnnotationParamsT = Static<typeof AddPdfAnnotationParams>;
export type ListPdfAnnotationsParamsT = Static<typeof ListPdfAnnotationsParams>;
export type RemovePdfAnnotationParamsT = Static<typeof RemovePdfAnnotationParams>;

export const PDF_ANNOTATION_TOOL_NAMES = [
  "add_pdf_annotation",
  "list_pdf_annotations",
  "remove_pdf_annotation",
] as const;

const PDF_GUIDELINES = [
  "When reviewing or discussing a sandbox PDF, use `add_pdf_annotation` for specific findings the user benefits from jumping to.",
  "Use one concise annotation per distinct finding; annotations are not a scratchpad or a substitute for the main response.",
  "Only create a highlight when you know exact PDF user-space rectangles. Otherwise create a note at a reasonable page anchor rather than inventing a highlight box.",
  "PDF coordinates are page-local points with the origin at bottom-left and y increasing upward; pages are 1-indexed.",
  "List existing annotations before adding several findings so you do not create duplicates. Never remove user-authored annotations.",
];

function textResult(value: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    details,
  };
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

export function buildPdfAnnotation(
  params: AddPdfAnnotationParamsT,
  author: PdfAnnotationAuthor,
): PdfAnnotation {
  if (!Number.isInteger(params.page) || params.page < 1) {
    throw new Error("page must be a positive integer");
  }
  const base = {
    id: randomUUID(),
    page: params.page,
    author,
    createdAt: new Date().toISOString(),
    ...(params.color ? { color: params.color } : {}),
  };

  if (params.type === "highlight") {
    const text = params.text?.trim() ?? "";
    if (!text) throw new Error("highlight requires non-empty text");
    if (!params.rects?.length) throw new Error("highlight requires rects");
    const rects = params.rects.map((rect, index) => {
      const w = finite(rect.w, `rects[${index}].w`);
      const h = finite(rect.h, `rects[${index}].h`);
      if (w <= 0 || h <= 0) {
        throw new Error(`rects[${index}] width and height must be positive`);
      }
      return {
        x: finite(rect.x, `rects[${index}].x`),
        y: finite(rect.y, `rects[${index}].y`),
        w,
        h,
      };
    });
    return {
      ...base,
      type: "highlight",
      text,
      rects,
      ...(params.note?.trim() ? { note: params.note.trim() } : {}),
    };
  }

  const body = params.body?.trim() ?? "";
  if (!body) throw new Error("note requires a non-empty body");
  if (!params.anchor) throw new Error("note requires an anchor");
  return {
    ...base,
    type: "note",
    anchor: {
      x: finite(params.anchor.x, "anchor.x"),
      y: finite(params.anchor.y, "anchor.y"),
    },
    body,
  };
}

export async function addPdfAnnotation(
  sandboxRoot: string,
  params: AddPdfAnnotationParamsT,
  author: PdfAnnotationAuthor,
): Promise<PdfAnnotation> {
  const annotation = buildPdfAnnotation(params, author);
  await mutatePdfAnnotations(sandboxRoot, params.pdf_path, (doc) => ({
    doc: {
      version: 1,
      annotations: [...doc.annotations, annotation],
    },
    value: annotation,
  }));
  return annotation;
}

export function listPdfAnnotations(
  sandboxRoot: string,
  params: ListPdfAnnotationsParamsT,
): { annotations: PdfAnnotation[]; total: number; truncated: boolean } {
  let annotations = readPdfAnnotations(sandboxRoot, params.pdf_path).doc.annotations;
  if (params.author_kind) {
    annotations = annotations.filter(
      (annotation) => annotation.author?.kind === params.author_kind,
    );
  }
  if (params.page !== undefined) {
    annotations = annotations.filter(
      (annotation) => annotation.page === params.page,
    );
  }
  const total = annotations.length;
  return {
    annotations: annotations.slice(0, 200),
    total,
    truncated: total > 200,
  };
}

export async function removePdfAnnotation(
  sandboxRoot: string,
  params: RemovePdfAnnotationParamsT,
): Promise<{ removed: boolean; remaining: number; protected: boolean }> {
  return (
    await mutatePdfAnnotations(sandboxRoot, params.pdf_path, (doc) => {
      const target = doc.annotations.find(
        (annotation) => annotation.id === params.annotation_id,
      );
      const protectedAnnotation = target?.author?.kind === "user";
      const removed = Boolean(target && !protectedAnnotation);
      const next: PdfAnnotationsDoc = {
        version: 1,
        annotations: removed
          ? doc.annotations.filter(
              (annotation) => annotation.id !== params.annotation_id,
            )
          : doc.annotations,
      };
      return {
        doc: next,
        value: {
          removed,
          remaining: next.annotations.length,
          protected: Boolean(protectedAnnotation),
        },
      };
    })
  ).value;
}

export function makePdfAnnotationTools(
  projectId: string,
  author: PdfAnnotationAuthor = {
    kind: "expert",
    id: "kady",
    label: "Kady",
  },
): ToolDefinition<any>[] {
  const sandboxRoot = resolvePaths(projectId).sandbox;

  const add: ToolDefinition<typeof AddPdfAnnotationParams> = {
    name: "add_pdf_annotation",
    label: "Annotate PDF",
    description: [
      "Add a highlight or sticky note that appears live in Kady's PDF viewer.",
      "Use sandbox-relative PDF paths. Pages are 1-indexed.",
      "Coordinates are PDF user-space points: origin bottom-left, y grows upward, 72 points per inch.",
      "Highlights require exact `rects` and selected `text`; notes require an `anchor` and short `body`.",
      "If exact text coordinates are unavailable, prefer a note at a reasonable page anchor.",
    ].join("\n"),
    promptSnippet:
      "add_pdf_annotation: add a visible expert highlight or note to a sandbox PDF",
    promptGuidelines: PDF_GUIDELINES,
    parameters: AddPdfAnnotationParams,
    execute: async (_toolCallId, params) => {
      const annotation = await addPdfAnnotation(sandboxRoot, params, author);
      touchProject(projectId);
      return textResult(annotation, { annotation });
    },
  };

  const list: ToolDefinition<typeof ListPdfAnnotationsParams> = {
    name: "list_pdf_annotations",
    label: "List PDF annotations",
    description:
      "List annotations already attached to a sandbox PDF, optionally filtering by page or user/expert author.",
    promptSnippet:
      "list_pdf_annotations: inspect existing user and expert PDF annotations",
    parameters: ListPdfAnnotationsParams,
    execute: async (_toolCallId, params) => {
      const result = listPdfAnnotations(sandboxRoot, params);
      return textResult(result, result);
    },
  };

  const remove: ToolDefinition<typeof RemovePdfAnnotationParams> = {
    name: "remove_pdf_annotation",
    label: "Remove PDF annotation",
    description:
      "Remove an expert-authored PDF annotation by id. User-authored annotations are protected and cannot be removed.",
    promptSnippet:
      "remove_pdf_annotation: remove an expert PDF annotation while preserving user annotations",
    promptGuidelines: [
      "Only remove an expert annotation when correcting or cleaning up your own markup. Never remove user-authored annotations.",
    ],
    parameters: RemovePdfAnnotationParams,
    execute: async (_toolCallId, params) => {
      const result = await removePdfAnnotation(sandboxRoot, params);
      if (result.removed) touchProject(projectId);
      return textResult(result, result);
    },
  };

  return [add, list, remove];
}
