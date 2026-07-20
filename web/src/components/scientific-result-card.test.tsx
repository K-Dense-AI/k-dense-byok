import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScientificResultCard } from "./scientific-result-card";
import type { ScientificResultCard as Card } from "@/lib/scientific-results";
import type { ActivityItem } from "@/lib/use-agent";

function item(card: Card, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "result-1",
    label: "Scientific result",
    status: "complete",
    timestamp: 1,
    toolName: "scientific_result",
    scientificResult: card,
    ...extra,
  };
}

const renderCard = (
  card: Card,
  props: { onOpenFile?: (path: string) => void; extra?: Partial<ActivityItem> } = {},
) =>
  render(
    <ScientificResultCard
      item={item(card, props.extra)}
      projectId="default"
      onOpenFile={props.onOpenFile}
    />,
  );

describe("ScientificResultCard", () => {
  it("renders bounded table previews", () => {
    renderCard({
      schemaVersion: 1,
      kind: "table",
      title: "Top genes",
      columns: [
        { key: "gene", label: "Gene" },
        { key: "lfc", label: "log2FC" },
      ],
      rows: [["TP53", 2.4]],
      totalRows: 200,
      truncated: true,
    });
    expect(screen.getByText("Top genes")).toBeInTheDocument();
    expect(screen.getByText("TP53")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 200 rows/)).toBeInTheDocument();
  });

  it("renders statistical tests without claiming verification", () => {
    renderCard({
      schemaVersion: 1,
      kind: "statistical-test",
      title: "Treatment effect",
      tests: [
        {
          name: "Welch t-test",
          statistic: 2.4,
          pValue: 0.02,
          confidenceInterval: [0.1, 1.3],
          sampleSize: 12,
        },
      ],
    });
    expect(screen.getByText("Welch t-test")).toBeInTheDocument();
    expect(screen.getByText("p-value")).toBeInTheDocument();
    expect(screen.getByText(/not independently verified/i)).toBeInTheDocument();
  });

  it("opens an artifact-backed plot", () => {
    const onOpenFile = vi.fn();
    renderCard(
      {
        schemaVersion: 1,
        kind: "plot",
        title: "Volcano plot",
        images: [{ path: "figures/volcano.png", alt: "Volcano plot image" }],
      },
      { onOpenFile },
    );
    fireEvent.click(screen.getByRole("button", { name: "Volcano plot image" }));
    expect(onOpenFile).toHaveBeenCalledWith("figures/volcano.png");
  });

  it("renders and opens artifact bundles", () => {
    const onOpenFile = vi.fn();
    renderCard(
      {
        schemaVersion: 1,
        kind: "artifact-list",
        title: "Outputs",
        items: [
          { path: "results.csv", label: "Results table", role: "table" },
          { path: "analysis.py", role: "script" },
        ],
      },
      { onOpenFile },
    );
    fireEvent.click(screen.getByRole("button", { name: /Results table/ }));
    expect(onOpenFile).toHaveBeenCalledWith("results.csv");
  });

  it("renders pass, warning, and failure QC checks", () => {
    renderCard({
      schemaVersion: 1,
      kind: "qc-report",
      title: "Read QC",
      overall: "warn",
      checks: [
        { name: "Read depth", status: "pass", value: 1_000_000 },
        { name: "Adapter content", status: "warn", value: 3.2 },
        { name: "Contamination", status: "fail", message: "Above threshold" },
      ],
    });
    expect(screen.getAllByText("Warning").length).toBeGreaterThan(0);
    expect(screen.getByText("Read depth")).toBeInTheDocument();
    expect(screen.getByText("Above threshold")).toBeInTheDocument();
  });

  it("renders dataset shape and field schema", () => {
    renderCard({
      schemaVersion: 1,
      kind: "dataset-schema",
      title: "Counts matrix",
      format: "CSV",
      shape: [100, 6],
      fields: [{ name: "gene", dtype: "string", unique: 100 }],
    });
    expect(screen.getByText("dim1: 100")).toBeInTheDocument();
    expect(screen.getByText("gene")).toBeInTheDocument();
    expect(screen.getByText("string")).toBeInTheDocument();
  });

  it("renders citations as reported links without a verified status", () => {
    renderCard({
      schemaVersion: 1,
      kind: "citation-list",
      title: "Sources",
      entries: [
        {
          kind: "doi",
          identifier: "10.1000/example",
          title: "Example paper",
          url: "https://doi.org/10.1000/example",
        },
      ],
    });
    expect(screen.getByText("Example paper")).toBeInTheDocument();
    expect(screen.queryByText("verified")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open citation/ })).toHaveAttribute(
      "href",
      "https://doi.org/10.1000/example",
    );
  });

  it("renders molecule metadata and inline Pi result images", () => {
    renderCard(
      {
        schemaVersion: 1,
        kind: "molecule",
        title: "Ethanol",
        formula: "C2H6O",
        smiles: "CCO",
        molecularWeight: 46.07,
      },
      {
        extra: {
          resultImages: [{ data: "aGVsbG8=", mimeType: "image/png" }],
          resultImagesTruncated: 1,
        },
      },
    );
    expect(screen.getByText("C2H6O")).toBeInTheDocument();
    expect(screen.getByAltText("Tool result image 1")).toBeInTheDocument();
    expect(screen.getByText(/1 image omitted/)).toBeInTheDocument();
  });
});
