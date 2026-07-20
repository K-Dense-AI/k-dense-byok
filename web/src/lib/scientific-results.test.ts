import { describe, expect, it } from "vitest";
import {
  parseScientificResult,
  parseToolResultImages,
} from "./scientific-results";

const cards = [
  {
    schemaVersion: 1,
    kind: "table",
    title: "Table",
    columns: [{ key: "x", label: "X" }],
    rows: [[1]],
  },
  {
    schemaVersion: 1,
    kind: "statistical-test",
    title: "Test",
    tests: [{ name: "Welch t-test", pValue: 0.01 }],
  },
  {
    schemaVersion: 1,
    kind: "plot",
    title: "Plot",
    images: [{ path: "plot.png", alt: "Plot" }],
  },
  {
    schemaVersion: 1,
    kind: "artifact-list",
    title: "Artifacts",
    items: [{ path: "results.csv" }],
  },
  {
    schemaVersion: 1,
    kind: "qc-report",
    title: "QC",
    overall: "pass",
    checks: [{ name: "Reads", status: "pass" }],
  },
  {
    schemaVersion: 1,
    kind: "dataset-schema",
    title: "Dataset",
    shape: [10, 2],
  },
  {
    schemaVersion: 1,
    kind: "citation-list",
    title: "Citations",
    entries: [{ kind: "doi", identifier: "10.1000/example" }],
  },
  {
    schemaVersion: 1,
    kind: "molecule",
    title: "Molecule",
    smiles: "CCO",
  },
];

describe("parseScientificResult", () => {
  it.each(cards.map((card) => [card.kind, card] as const))(
    "accepts a valid %s card",
    (kind, card) => {
      expect(parseScientificResult(card)).toMatchObject({ kind, title: card.title });
    },
  );

  it("rejects unknown versions, kinds, and malformed nested data", () => {
    expect(
      parseScientificResult({
        schemaVersion: 2,
        kind: "table",
        title: "Future",
        columns: [],
        rows: [],
      }),
    ).toBeNull();
    expect(
      parseScientificResult({
        schemaVersion: 1,
        kind: "unknown",
        title: "Unknown",
      }),
    ).toBeNull();
    expect(
      parseScientificResult({
        schemaVersion: 1,
        kind: "table",
        title: "Mismatch",
        columns: [{ key: "a", label: "A" }],
        rows: [[1, 2]],
      }),
    ).toBeNull();
    expect(
      parseScientificResult({
        schemaVersion: 1,
        kind: "citation-list",
        title: "Unsafe nested shape",
        entries: [{ kind: "doi", identifier: "x", authors: "not-an-array" }],
      }),
    ).toBeNull();
  });
});

describe("parseToolResultImages", () => {
  it("keeps supported raster blocks and rejects malformed/unsafe MIME values", () => {
    expect(
      parseToolResultImages([
        { data: "aGVsbG8=", mimeType: "image/png" },
        { data: "svg", mimeType: "image/svg+xml" },
        { data: "", mimeType: "image/jpeg" },
      ]),
    ).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
  });
});
