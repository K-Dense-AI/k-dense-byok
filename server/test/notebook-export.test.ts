import { describe, it, expect } from "vitest";
import { notebookToMarkdown } from "../src/agent/notebook-export.ts";
import type { NotebookEntry } from "../src/agent/notebook-store.ts";

const entries: NotebookEntry[] = [
  { id: "a", type: "hypothesis", title: "Six types", body: "k=6.", timestamp: 1000, role: "agent", confidence: "high" },
  { id: "b", type: "observation", title: "ARI 0.995", timestamp: 2000, role: "agent",
    artifacts: ["figures/fig08_silhouette.png", "data/counts.csv"],
    code: { source: "print('hi')", lang: "python" } },
];

describe("notebookToMarkdown", () => {
  const md = notebookToMarkdown(entries, { sessionId: "sess-1", projectName: "TME scRNA-seq" });

  it("has a titled header naming the project and session", () => {
    expect(md).toMatch(/# Lab Notebook/);
    expect(md).toMatch(/TME scRNA-seq/);
    expect(md).toMatch(/sess-1/);
  });

  it("renders each entry's type label and title", () => {
    expect(md).toMatch(/Hypothesis/);
    expect(md).toMatch(/Six types/);
    expect(md).toMatch(/Observation/);
  });

  it("embeds image artifacts as images and other files as links", () => {
    expect(md).toContain("![fig08_silhouette.png](figures/fig08_silhouette.png)");
    expect(md).toContain("[data/counts.csv](data/counts.csv)");
  });

  it("renders code as a fenced block with its language", () => {
    expect(md).toContain("```python");
    expect(md).toContain("print('hi')");
  });
});

describe("notebookToMarkdown attribution + thread links", () => {
  const linked: NotebookEntry[] = [
    { id: "h1", type: "hypothesis", title: "Six types", timestamp: 1000, role: "agent" },
    { id: "o1", type: "observation", title: "ARI 0.99", timestamp: 2000, role: "stats-checker",
      relatesTo: "h1", stance: "supports" },
    { id: "d1", type: "decision", title: "Use k=6", timestamp: 3000, role: "agent",
      supersedes: "h1" },
  ];
  const md = notebookToMarkdown(linked, { sessionId: "sess-2" });

  it("attributes each entry with `by <role>`", () => {
    expect(md).toMatch(/by agent/);
    expect(md).toMatch(/by stats-checker/);
  });

  it("renders a relatesTo line with the stance and target title", () => {
    expect(md).toContain("↳ supports “Six types” (h1)");
  });

  it("renders a supersedes line with the target title", () => {
    expect(md).toContain("↺ supersedes “Six types” (h1)");
  });

  it("marks the superseded target entry", () => {
    expect(md).toContain("⚠ superseded by “Use k=6”");
  });
});

describe("notebookToMarkdown artifact rewriting", () => {
  const withArtifacts: NotebookEntry[] = [
    { id: "x", type: "observation", title: "fig", timestamp: 1, role: "agent",
      artifacts: ["figures/a.png", "data/t.csv"] },
  ];

  it("rewrites artifact link targets via artifactHref", () => {
    const md = notebookToMarkdown(withArtifacts, {
      sessionId: "s",
      artifactHref: (p) => `artifacts/${p}`,
    });
    expect(md).toContain("![a.png](artifacts/figures/a.png)");
    expect(md).toContain("[data/t.csv](artifacts/data/t.csv)");
  });

  it("notes a missing artifact instead of linking it", () => {
    const md = notebookToMarkdown(
      [{ id: "x", type: "observation", title: "fig", timestamp: 1, role: "agent",
         artifacts: ["figures/gone.png"] }],
      { sessionId: "s", missingArtifacts: new Set(["figures/gone.png"]) },
    );
    expect(md).toContain("`figures/gone.png` _(artifact missing at export time)_");
    expect(md).not.toContain("![gone.png]");
  });
});
