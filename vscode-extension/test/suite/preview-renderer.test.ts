import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { renderKadyPreview } from "../../src/preview/kady-preview-renderer";

suite("preview renderer", () => {
  test("renders markdown with math, mermaid, and highlighted code", async () => {
    const preview = await renderKadyPreview({
      resource: vscode.Uri.parse("file:///workspace/preview.md"),
      workspaceTargetName: "workspace-a",
      content: [
        "# Preview fixture",
        "",
        "Inline math $E=mc^2$ stays rendered.",
        "",
        "```mermaid",
        "graph TD",
        "  A[Input] --> B[Output]",
        "```",
        "",
        "```ts",
        "const answer = 42;",
        "```",
      ].join("\n"),
    });

    assert.equal(preview.format, "markdown");
    assert.match(preview.bodyHtml, /data-kady-preview-format="markdown"/);
    assert.match(preview.bodyHtml, /<math/);
    assert.match(preview.bodyHtml, /<pre class="mermaid">/);
    assert.match(preview.bodyHtml, /language-ts/);
  });

  test("renders TSV data as a structured table", async () => {
    const preview = await renderKadyPreview({
      resource: vscode.Uri.parse("file:///workspace/results.tsv"),
      content: "sample\tvalue\nalpha\t1\nbeta\t2\n",
    });

    assert.equal(preview.format, "table");
    assert.match(preview.bodyHtml, /Structured table preview/);
    assert.match(preview.bodyHtml, /<table class="preview-table">/);
    assert.match(preview.bodyHtml, /alpha/);
  });

  test("renders FASTA records with bioinformatics affordances", async () => {
    const preview = await renderKadyPreview({
      resource: vscode.Uri.parse("file:///workspace/sequences.fasta"),
      content: [
        ">seq1 Homo sapiens sample",
        "ACGTACGTNN",
        ">seq2 protein sample",
        "MKWVTFISLLFLFSSAYS",
      ].join("\n"),
    });

    assert.equal(preview.format, "fasta");
    assert.match(preview.bodyHtml, /Bioinformatics preview/);
    assert.match(preview.bodyHtml, /seq1/);
    assert.match(preview.bodyHtml, /GC/);
  });

  test("renders LaTeX preview with compile controls and live output regions", async () => {
    const preview = await renderKadyPreview({
      resource: vscode.Uri.parse("file:///workspace/paper.tex"),
      companionPdfUri: vscode.Uri.parse("file:///workspace/paper.pdf"),
      toWebviewUri: (uri) => uri,
      trustState: {
        isTrusted: true,
        mode: "trusted",
        statusLabel: "Trusted Mode",
        summary: "trusted",
        detail: "trusted detail",
        capabilities: {
          readOnlyUi: true,
          previewOpen: true,
          write: true,
          execute: true,
          backendStart: true,
          secretSensitive: true,
        },
        allowedCapabilities: ["readOnlyUi", "previewOpen", "write", "execute", "backendStart", "secretSensitive"],
        blockedCapabilities: [],
      },
      content: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Intro}",
        "$x^2$",
        "\\end{document}",
      ].join("\n"),
    });

      assert.equal(preview.format, "latex");
    assert.match(preview.bodyHtml, /data-latex-compile/);
    assert.match(preview.bodyHtml, /data-latex-engine/);
    assert.match(preview.bodyHtml, /data-latex-log/);
    assert.match(preview.bodyHtml, /data-latex-output/);
    assert.match(preview.bodyHtml, /<iframe class="preview-pdf-frame"/);
  });

  test("renders a BCF-specific binary summary instead of the generic fallback", async () => {
    const rawBytes = Uint8Array.from([
      0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00,
      0x00, 0xff, 0x06, 0x00, 0x42, 0x43, 0x02, 0x00,
      0x1b, 0x00, 0x03, 0x00,
    ]);

    const preview = await renderKadyPreview({
      resource: vscode.Uri.parse("file:///workspace/variants.bcf"),
      workspaceTargetName: "workspace-b",
      rawBytes,
      sizeBytes: rawBytes.byteLength,
      content: "",
    });

    assert.equal(preview.format, "bcf");
    assert.match(preview.bodyHtml, /data-kady-preview-format="bcf"/);
    assert.match(preview.bodyHtml, /Binary Call Format files get a binary-aware summary/);
    assert.match(preview.bodyHtml, /BGZF-wrapped binary payload/);
    assert.doesNotMatch(preview.bodyHtml, /does not have a richer bundled renderer yet/);
  });
});
