/**
 * Child-agent PDF annotation tools.
 *
 * The in-process lead session registers the same three tools directly. This
 * package self-gates on PI_SUBAGENT_CHILD so delegated specialists can write
 * expert annotations into the shared sandbox without duplicating tools in the
 * parent process.
 */
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  AddPdfAnnotationParams,
  ListPdfAnnotationsParams,
  PDF_ANNOTATION_TOOL_NAMES,
  RemovePdfAnnotationParams,
  addPdfAnnotation,
  listPdfAnnotations,
  removePdfAnnotation,
  type AddPdfAnnotationParamsT,
  type ListPdfAnnotationsParamsT,
  type RemovePdfAnnotationParamsT,
} from "../../src/agent/pdf-annotation-tool.ts";
import type { PdfAnnotationAuthor } from "../../src/pdf-annotations-store.ts";

function childAuthor(): PdfAnnotationAuthor {
  const raw =
    process.env.PI_SUBAGENT_CHILD_AGENT?.trim() ||
    process.env.PI_SUBAGENT_RUN_ID?.trim() ||
    "subagent";
  const label = raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
  return {
    kind: "expert",
    id: raw,
    label: label || "Subagent",
  };
}

function result(value: unknown, details: Record<string, unknown> = {}) {
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

export function makeChildPdfAnnotationTools(
  sandboxRoot = process.cwd(),
  author: PdfAnnotationAuthor = childAuthor(),
): ToolDefinition<any>[] {
  const add: ToolDefinition<typeof AddPdfAnnotationParams> = {
    name: "add_pdf_annotation",
    label: "Annotate PDF",
    description: [
      "Add a highlight or sticky note that appears live in Kady's PDF viewer.",
      "Use a sandbox-relative PDF path. Pages are 1-indexed; coordinates are PDF points with origin bottom-left and y growing upward.",
      "Only use highlights with exact rectangles. If coordinates are uncertain, add a concise note at a reasonable page anchor.",
    ].join("\n"),
    promptSnippet:
      "add_pdf_annotation: add a visible expert highlight or note to a sandbox PDF",
    promptGuidelines: [
      "Annotate specific PDF findings the user benefits from jumping to; do not use annotations as a scratchpad.",
      "Prefer a note unless you know exact PDF user-space rectangles for a highlight.",
      "List existing annotations before adding several findings, and never remove user-authored annotations.",
    ],
    parameters: AddPdfAnnotationParams,
    execute: async (_toolCallId, params: AddPdfAnnotationParamsT) => {
      const annotation = await addPdfAnnotation(sandboxRoot, params, author);
      return result(annotation, { annotation });
    },
  };

  const list: ToolDefinition<typeof ListPdfAnnotationsParams> = {
    name: "list_pdf_annotations",
    label: "List PDF annotations",
    description:
      "List annotations already attached to a sandbox PDF, optionally filtered by page or author kind.",
    parameters: ListPdfAnnotationsParams,
    execute: async (_toolCallId, params: ListPdfAnnotationsParamsT) => {
      const annotations = listPdfAnnotations(sandboxRoot, params);
      return result(annotations, annotations);
    },
  };

  const remove: ToolDefinition<typeof RemovePdfAnnotationParams> = {
    name: "remove_pdf_annotation",
    label: "Remove PDF annotation",
    description:
      "Remove an expert-authored PDF annotation by id. User annotations are protected.",
    parameters: RemovePdfAnnotationParams,
    execute: async (_toolCallId, params: RemovePdfAnnotationParamsT) => {
      const removed = await removePdfAnnotation(sandboxRoot, params);
      return result(removed, removed);
    },
  };

  return [add, list, remove];
}

export const pdfAnnotationChildTools = makeChildPdfAnnotationTools();

export default function registerPdfAnnotationTools(pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT_CHILD) return;
  for (const tool of makeChildPdfAnnotationTools()) pi.registerTool(tool);
}

export {
  AddPdfAnnotationParams,
  ListPdfAnnotationsParams,
  PDF_ANNOTATION_TOOL_NAMES,
  RemovePdfAnnotationParams,
};
