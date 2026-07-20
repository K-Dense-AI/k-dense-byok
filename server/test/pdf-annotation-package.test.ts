import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerPackage, {
  PDF_ANNOTATION_TOOL_NAMES,
  makeChildPdfAnnotationTools,
} from "../pi-packages/kady-pdf-annotations/index.ts";
import {
  kadyPdfAnnotationPackageDir,
  seedBuiltinAgentPdfAnnotationTools,
  seedPdfAnnotationPackage,
} from "../src/agent/pdf-annotation-bridge.ts";
import {
  seedBuiltinAgentNotebookTools,
  seedNotebookPackage,
} from "../src/agent/notebook-bridge.ts";
import {
  seedBuiltinAgentModalTools,
  seedModalPackage,
} from "../src/agent/modal-bridge.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { readPdfAnnotations } from "../src/pdf-annotations-store.ts";

const originalChild = process.env.PI_SUBAGENT_CHILD;
const originalAgent = process.env.PI_SUBAGENT_CHILD_AGENT;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
  if (originalAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
  else process.env.PI_SUBAGENT_CHILD_AGENT = originalAgent;
});

describe("kady-pdf-annotations child package", () => {
  it("registers all PDF tools only in child processes", () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const child: { name: string }[] = [];
    registerPackage({
      registerTool: (tool: { name: string }) => child.push(tool),
    } as never);
    expect(child.map((tool) => tool.name)).toEqual([
      ...PDF_ANNOTATION_TOOL_NAMES,
    ]);

    delete process.env.PI_SUBAGENT_CHILD;
    const parent: unknown[] = [];
    registerPackage({
      registerTool: (tool: unknown) => parent.push(tool),
    } as never);
    expect(parent).toEqual([]);
  });

  it("writes a child annotation with the specialist identity", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "paper.pdf"), "%PDF-1.4\n");
    process.env.PI_SUBAGENT_CHILD_AGENT = "biostatistician";
    const add = makeChildPdfAnnotationTools(paths.sandbox).find(
      (tool) => tool.name === "add_pdf_annotation",
    )!;

    await add.execute(
      "tool-call",
      {
        pdf_path: "paper.pdf",
        type: "note",
        page: 3,
        anchor: { x: 100, y: 650 },
        body: "Model assumptions need checking.",
      },
      undefined as never,
    );

    expect(
      readPdfAnnotations(paths.sandbox, "paper.pdf").doc.annotations[0],
    ).toMatchObject({
      type: "note",
      body: "Model assumptions need checking.",
      author: {
        kind: "expert",
        id: "biostatistician",
        label: "Biostatistician",
      },
    });
  });

  it("seeds the package and extends generated builtin allowlists idempotently", () => {
    const paths = ensureProjectExists("default");
    seedNotebookPackage(paths);
    seedBuiltinAgentNotebookTools(paths);
    seedModalPackage(paths);
    seedBuiltinAgentModalTools(paths);

    expect(seedPdfAnnotationPackage(paths)).toBe(true);
    expect(seedPdfAnnotationPackage(paths)).toBe(false);
    expect(seedBuiltinAgentPdfAnnotationTools(paths)).toBe(true);
    expect(seedBuiltinAgentPdfAnnotationTools(paths)).toBe(false);

    const settings = JSON.parse(
      fs.readFileSync(
        path.join(paths.sandbox, ".pi", "settings.json"),
        "utf-8",
      ),
    ) as any;
    expect(settings.packages).toContain(kadyPdfAnnotationPackageDir());
    const tools = settings.subagents.agentOverrides.researcher.tools as string[];
    for (const name of PDF_ANNOTATION_TOOL_NAMES) {
      expect(tools).toContain(name);
    }
  });

  it("does not replace a user-pinned builtin tool list", () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(path.join(paths.sandbox, ".pi"), { recursive: true });
    const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        subagents: {
          agentOverrides: {
            researcher: { tools: ["read"] },
          },
        },
      }),
      "utf-8",
    );

    seedBuiltinAgentPdfAnnotationTools(paths);
    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as any;
    expect(settings.subagents.agentOverrides.researcher.tools).toEqual([
      "read",
    ]);
  });
});
