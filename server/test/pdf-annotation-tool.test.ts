import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  PDF_ANNOTATION_TOOL_NAMES,
  makePdfAnnotationTools,
} from "../src/agent/pdf-annotation-tool.ts";
import {
  readPdfAnnotations,
  replacePdfAnnotations,
} from "../src/pdf-annotations-store.ts";
import { ensureProjectExists } from "../src/projects.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

function setup() {
  const paths = ensureProjectExists("default");
  fs.writeFileSync(path.join(paths.sandbox, "paper.pdf"), "%PDF-1.4\n");
  const tools = Object.fromEntries(
    makePdfAnnotationTools("default").map((tool) => [tool.name, tool]),
  );
  const run = (name: string, params: unknown) =>
    tools[name].execute("tool-call", params as never, undefined as never);
  return { paths, tools, run };
}

describe("PDF annotation agent tools", () => {
  it("registers the complete legacy-compatible tool surface", () => {
    const { tools } = setup();
    expect(Object.keys(tools)).toEqual([...PDF_ANNOTATION_TOOL_NAMES]);
  });

  it("adds and lists an expert note in the viewer sidecar", async () => {
    const { paths, run } = setup();
    const added = await run("add_pdf_annotation", {
      pdf_path: "paper.pdf",
      type: "note",
      page: 2,
      anchor: { x: 72, y: 700 },
      body: "Endpoint differs from the preregistration.",
    });
    const annotation = added.details.annotation as any;
    expect(annotation).toMatchObject({
      type: "note",
      page: 2,
      body: "Endpoint differs from the preregistration.",
      author: { kind: "expert", id: "kady", label: "Kady" },
    });

    const stored = readPdfAnnotations(paths.sandbox, "paper.pdf").doc;
    expect(stored.annotations).toEqual([annotation]);

    const listed = await run("list_pdf_annotations", {
      pdf_path: "paper.pdf",
      author_kind: "expert",
      page: 2,
    });
    expect((listed.details as any).total).toBe(1);
    expect((listed.details as any).annotations[0].id).toBe(annotation.id);
  });

  it("validates highlight geometry and required content", async () => {
    const { run } = setup();
    await expect(
      run("add_pdf_annotation", {
        pdf_path: "paper.pdf",
        type: "highlight",
        page: 1,
        text: "Selected sentence",
      }),
    ).rejects.toThrow(/rects/i);
    await expect(
      run("add_pdf_annotation", {
        pdf_path: "paper.pdf",
        type: "highlight",
        page: 1,
        text: "Selected sentence",
        rects: [{ x: 10, y: 20, w: -1, h: 12 }],
      }),
    ).rejects.toThrow(/positive/i);
  });

  it("removes expert annotations but protects user annotations", async () => {
    const { paths, run } = setup();
    await replacePdfAnnotations(paths.sandbox, "paper.pdf", {
      version: 1,
      annotations: [
        {
          id: "user-note",
          type: "note",
          page: 1,
          anchor: { x: 10, y: 20 },
          body: "Keep me",
          author: { kind: "user", id: "local", label: "You" },
          createdAt: "2026-07-20T00:00:00.000Z",
        },
        {
          id: "expert-note",
          type: "note",
          page: 1,
          anchor: { x: 30, y: 40 },
          body: "Remove me",
          author: { kind: "expert", id: "kady", label: "Kady" },
          createdAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    });

    const protectedResult = await run("remove_pdf_annotation", {
      pdf_path: "paper.pdf",
      annotation_id: "user-note",
    });
    expect(protectedResult.details).toMatchObject({
      removed: false,
      protected: true,
      remaining: 2,
    });

    const removed = await run("remove_pdf_annotation", {
      pdf_path: "paper.pdf",
      annotation_id: "expert-note",
    });
    expect(removed.details).toMatchObject({
      removed: true,
      protected: false,
      remaining: 1,
    });
    expect(
      readPdfAnnotations(paths.sandbox, "paper.pdf").doc.annotations.map(
        (annotation) => annotation.id,
      ),
    ).toEqual(["user-note"]);
  });

  it("serializes concurrent agent writes without losing annotations", async () => {
    const { paths, run } = setup();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        run("add_pdf_annotation", {
          pdf_path: "paper.pdf",
          type: "note",
          page: 1,
          anchor: { x: 72, y: 700 - index },
          body: `Finding ${index}`,
        }),
      ),
    );
    const stored = readPdfAnnotations(paths.sandbox, "paper.pdf").doc;
    expect(stored.annotations).toHaveLength(12);
    expect(new Set(stored.annotations.map((annotation) => annotation.id)).size).toBe(12);
  });

  it("rejects traversal, missing files, and non-PDF targets", async () => {
    const { paths, run } = setup();
    fs.writeFileSync(path.join(paths.sandbox, "notes.txt"), "text");
    await expect(
      run("list_pdf_annotations", { pdf_path: "../outside.pdf" }),
    ).rejects.toThrow(/traversal|relative/i);
    await expect(
      run("list_pdf_annotations", { pdf_path: "missing.pdf" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      run("list_pdf_annotations", { pdf_path: "notes.txt" }),
    ).rejects.toThrow(/PDF/i);
  });
});
