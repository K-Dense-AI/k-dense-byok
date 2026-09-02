import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  MAX_SCIENTIFIC_RESULT_BYTES,
  ScientificResultCardSchema,
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
      expect(Value.Check(ScientificResultCardSchema, card)).toBe(true);
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
    // A single over-long field is now caught earlier, by that kind's schema.
    await expect(
      run({
        schemaVersion: 1,
        kind: "table",
        title: "Huge summary",
        summary: "x".repeat(MAX_SCIENTIFIC_RESULT_BYTES),
        columns: [{ key: "a", label: "A" }],
        rows: [],
      }),
    ).rejects.toThrow(/summary must not have more than 2048 characters/);

    // The byte cap still guards a payload that is large in aggregate while every
    // individual field stays within its own limit.
    await expect(
      run({
        schemaVersion: 1,
        kind: "table",
        title: "Huge in aggregate",
        columns: Array.from({ length: 25 }, (_, i) => ({ key: `c${i}`, label: `C${i}` })),
        rows: Array.from({ length: 100 }, () =>
          Array.from({ length: 25 }, () => "x".repeat(500)),
        ),
      }),
    ).rejects.toThrow("exceeds 64KB");
  });

  // Pi hands `tool.parameters` to the provider verbatim, and OpenAI-style
  // function calling requires an object schema with `properties`. When this was
  // a top-level Type.Union the emitted schema was `{anyOf:[...]}` with no
  // `type` and no `properties`, so models on the openai-completions API saw no
  // schema at all and every call failed validation. Guard the shape, not just
  // the behaviour.
  describe("provider-facing parameter schema", () => {
    it("is an object schema with properties, not a bare union", () => {
      const schema = ScientificResultParams as unknown as {
        type?: string;
        properties?: Record<string, unknown>;
        anyOf?: unknown[];
      };
      expect(schema.type).toBe("object");
      expect(schema.anyOf).toBeUndefined();
      expect(Object.keys(schema.properties ?? {})).toContain("kind");
    });

    it("exposes every kind's fields as top-level properties", () => {
      const props = Object.keys(
        (ScientificResultParams as unknown as { properties: Record<string, unknown> })
          .properties,
      );
      for (const field of [
        "columns", "rows", "tests", "images", "items", "overall", "checks",
        "shape", "dimensions", "fields", "entries", "smiles", "inchi", "path",
      ]) {
        expect(props).toContain(field);
      }
    });

    // Anthropic validates tool input_schema against JSON Schema draft 2020-12
    // and rejects the ENTIRE request when any tool's schema uses a removed
    // keyword — so one legacy keyword here breaks every call on that provider,
    // not just this tool. Type.Tuple was emitting `additionalItems`.
    it("uses no keywords removed in JSON Schema draft 2020-12", () => {
      const removed = ["additionalItems", "dependencies", "definitions"];
      const found: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((item, i) => walk(item, `${path}[${i}]`));
          return;
        }
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (removed.includes(key)) found.push(`${path}/${key}`);
          walk(value, `${path}/${key}`);
        }
      };
      walk(ScientificResultParams, "");
      expect(found).toEqual([]);
    });

    it("keeps a confidence interval as a bounded number array", () => {
      const ci = (
        ScientificResultParams as unknown as {
          properties: {
            tests: { items: { properties: { confidenceInterval: Record<string, unknown> } } };
          };
        }
      ).properties.tests.items.properties.confidenceInterval;
      expect(ci.type).toBe("array");
      expect(ci.minItems).toBe(2);
      expect(ci.maxItems).toBe(2);
      expect(Array.isArray(ci.items)).toBe(false);
    });

    it("does not ask the model for schemaVersion", () => {
      const props = (
        ScientificResultParams as unknown as { properties: Record<string, unknown> }
      ).properties;
      expect(props.schemaVersion).toBeUndefined();
    });
  });

  describe("flat params to card assembly", () => {
    it("stamps schemaVersion the model never sent", async () => {
      const result = await run({
        kind: "statistical-test",
        title: "Welch t-test",
        tests: [{ name: "Welch", statistic: -6.05, pValue: 2.4e-7 }],
      });
      expect(scientificResultFromDetails(result.details)).toMatchObject({
        schemaVersion: 1,
        kind: "statistical-test",
      });
    });

    it("drops fields belonging to a different kind", async () => {
      const result = await run({
        kind: "statistical-test",
        title: "Welch t-test",
        tests: [{ name: "Welch", pValue: 0.01 }],
        // Table fields on a statistical-test card: silently ignored, because
        // failing here would burn a retry for something we can just drop.
        columns: [{ key: "a", label: "A" }],
        rows: [["x"]],
      });
      const card = scientificResultFromDetails(result.details)!;
      expect(card).not.toHaveProperty("columns");
      expect(card).not.toHaveProperty("rows");
    });

    it("ignores an unknown stray property instead of failing the call", async () => {
      const result = await run({
        kind: "plot",
        title: "Volcano plot",
        images: [{ path: "results/plot.png", alt: "Volcano" }],
        somethingInvented: true,
      });
      const card = scientificResultFromDetails(result.details)!;
      expect(card).not.toHaveProperty("somethingInvented");
      expect(card.kind).toBe("plot");
    });

    it("names the missing field for the kind rather than every branch", async () => {
      await expect(run({ kind: "table", title: "No data" })).rejects.toThrow(
        /A table result requires columns and rows; missing columns, rows/,
      );
      await expect(
        run({ kind: "qc-report", title: "Partial", overall: "pass" }),
      ).rejects.toThrow(/missing checks/);
    });

    it("reports a per-kind validation failure without union noise", async () => {
      await expect(
        run({ kind: "statistical-test", title: "Bad p", tests: [{ name: "t", pValue: 42 }] }),
      ).rejects.toThrow(/Invalid statistical-test result/);
    });
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
