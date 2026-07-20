import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  MAX_SCIENTIFIC_RESULT_BYTES,
  ScientificResultParams,
  makeScientificResultTool,
  scientificResultFromDetails,
} from "../src/agent/scientific-result.ts";

const projectId = "default";

const run = (params: unknown) =>
  makeScientificResultTool(projectId).execute(
    "tc_result",
    params as never,
    undefined,
    undefined,
    undefined as never,
  );

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  const sandbox = resolvePaths(projectId).sandbox;
  fs.mkdirSync(path.join(sandbox, "results"), { recursive: true });
  for (const name of ["plot.png", "data.csv", "molecule.sdf", "report.txt"]) {
    fs.writeFileSync(path.join(sandbox, "results", name), "fixture");
  }
});

const cards = [
  {
    schemaVersion: 1,
    kind: "table",
    title: "Top genes",
    columns: [{ key: "gene", label: "Gene" }],
    rows: [["TP53"]],
  },
  {
    schemaVersion: 1,
    kind: "statistical-test",
    title: "Treatment effect",
    tests: [{ name: "Welch t-test", statistic: 2.4, pValue: 0.02, sampleSize: 12 }],
  },
  {
    schemaVersion: 1,
    kind: "plot",
    title: "Volcano plot",
    images: [{ path: "results/plot.png", alt: "Volcano plot" }],
  },
  {
    schemaVersion: 1,
    kind: "artifact-list",
    title: "Analysis outputs",
    items: [{ path: "results/report.txt", role: "report" }],
  },
  {
    schemaVersion: 1,
    kind: "qc-report",
    title: "Read QC",
    overall: "warn",
    checks: [
      {
        name: "Adapter content",
        status: "warn",
        value: 3.2,
        artifact: "results/report.txt",
      },
    ],
  },
  {
    schemaVersion: 1,
    kind: "dataset-schema",
    title: "Counts matrix",
    path: "results/data.csv",
    shape: [100, 6],
    fields: [{ name: "gene", dtype: "string" }],
  },
  {
    schemaVersion: 1,
    kind: "citation-list",
    title: "Key sources",
    entries: [
      {
        kind: "doi",
        identifier: "10.1000/example",
        url: "https://doi.org/10.1000/example",
      },
    ],
  },
  {
    schemaVersion: 1,
    kind: "molecule",
    title: "Lead compound",
    path: "results/molecule.sdf",
    smiles: "CCO",
  },
] as const;

describe("scientific_result tool", () => {
  it.each(cards.map((card) => [card.kind, card] as const))(
    "accepts and returns a versioned %s card",
    async (_kind, card) => {
      expect(Value.Check(ScientificResultParams, card)).toBe(true);
      const result = await run(card);
      const details = result.details as { scientificResult: unknown };
      expect(scientificResultFromDetails(details)).toMatchObject({
        schemaVersion: 1,
        kind: card.kind,
        title: card.title,
      });
      expect((result.content[0] as { text: string }).text).toContain(card.title);
    },
  );

  it("normalizes absolute sandbox paths and common artifacts", async () => {
    const sandbox = resolvePaths(projectId).sandbox;
    const result = await run({
      schemaVersion: 1,
      kind: "plot",
      title: "Plot",
      images: [{ path: path.join(sandbox, "results", "plot.png"), alt: "Plot" }],
      artifacts: [{ path: path.join(sandbox, "results", "data.csv") }],
    });
    const card = scientificResultFromDetails(result.details)!;
    expect(card).toMatchObject({
      images: [{ path: "results/plot.png" }],
      artifacts: [{ path: "results/data.csv" }],
    });
  });

  it("rejects missing, escaping, non-image plot, and unsafe citation references", async () => {
    await expect(
      run({
        schemaVersion: 1,
        kind: "artifact-list",
        title: "Missing",
        items: [{ path: "results/missing.txt" }],
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      run({
        schemaVersion: 1,
        kind: "artifact-list",
        title: "Escape",
        items: [{ path: "../escape.txt" }],
      }),
    ).rejects.toThrow("leaves sandbox");
    await expect(
      run({
        schemaVersion: 1,
        kind: "plot",
        title: "Not an image",
        images: [{ path: "results/report.txt", alt: "Text" }],
      }),
    ).rejects.toThrow("must reference an image");
    await expect(
      run({
        schemaVersion: 1,
        kind: "citation-list",
        title: "Unsafe",
        entries: [{ kind: "url", identifier: "x", url: "javascript:alert(1)" }],
      }),
    ).rejects.toThrow("http or https");
  });

  it("rejects malformed table rows and oversized payloads", async () => {
    await expect(
      run({
        schemaVersion: 1,
        kind: "table",
        title: "Bad table",
        columns: [{ key: "a", label: "A" }],
        rows: [[1, 2]],
      }),
    ).rejects.toThrow("one value per column");
    await expect(
      run({
        schemaVersion: 1,
        kind: "table",
        title: "Huge",
        summary: "x".repeat(MAX_SCIENTIFIC_RESULT_BYTES),
        columns: [{ key: "a", label: "A" }],
        rows: [],
      }),
    ).rejects.toThrow("exceeds 64KB");
  });

  it("refuses arbitrary or malformed details envelopes", () => {
    expect(scientificResultFromDetails({ secret: "do not forward" })).toBeUndefined();
    expect(
      scientificResultFromDetails({
        scientificResult: { schemaVersion: 1, kind: "table", title: "Incomplete" },
      }),
    ).toBeUndefined();
  });
});
