import * as vscode from "vscode";
import hljs from "highlight.js";
import katex from "katex";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import type { WorkspaceTrustState } from "../shared/workspace-trust";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const LATEX_EXTENSIONS = new Set([".tex", ".latex"]);
const CSV_EXTENSIONS = new Set([".csv", ".tsv"]);
const FASTA_EXTENSIONS = new Set([".fasta", ".fa", ".fna", ".ffn", ".faa", ".frn"]);
const FASTQ_EXTENSIONS = new Set([".fastq", ".fq"]);
const BIO_TABLE_EXTENSIONS = new Set([".tsv", ".vcf", ".gff", ".gff3", ".bed", ".sam"]);
const BCF_EXTENSIONS = new Set([".bcf"]);

const DNA_BASE_COLORS: Record<string, string> = {
  A: "preview-base--adenine",
  C: "preview-base--cytosine",
  G: "preview-base--guanine",
  T: "preview-base--thymine",
  U: "preview-base--uracil",
  N: "preview-base--unknown",
};

const AA_BASE_COLORS: Record<string, string> = {
  A: "preview-aa--hydrophobic",
  V: "preview-aa--hydrophobic",
  I: "preview-aa--hydrophobic",
  L: "preview-aa--hydrophobic",
  M: "preview-aa--hydrophobic",
  F: "preview-aa--aromatic",
  Y: "preview-aa--aromatic",
  W: "preview-aa--aromatic",
  S: "preview-aa--polar",
  T: "preview-aa--polar",
  N: "preview-aa--polar",
  Q: "preview-aa--polar",
  K: "preview-aa--basic",
  R: "preview-aa--basic",
  H: "preview-aa--basic",
  D: "preview-aa--acidic",
  E: "preview-aa--acidic",
  C: "preview-aa--special",
  G: "preview-aa--special",
  P: "preview-aa--special",
};

const BIO_TABLE_DEFAULT_HEADERS: Record<string, string[]> = {
  bed: [
    "chrom",
    "chromStart",
    "chromEnd",
    "name",
    "score",
    "strand",
    "thickStart",
    "thickEnd",
    "itemRgb",
    "blockCount",
    "blockSizes",
    "blockStarts",
  ],
  sam: ["QNAME", "FLAG", "RNAME", "POS", "MAPQ", "CIGAR", "RNEXT", "PNEXT", "TLEN", "SEQ", "QUAL"],
  gff: ["seqname", "source", "feature", "start", "end", "score", "strand", "frame", "attribute"],
  gff3: ["seqname", "source", "feature", "start", "end", "score", "strand", "frame", "attribute"],
};

type PreviewFormat = "markdown" | "table" | "latex" | "fasta" | "fastq" | "bio-table" | "bcf" | "text";

export interface KadyPreviewRenderInput {
  resource: vscode.Uri;
  content: string;
  rawBytes?: Uint8Array;
  sizeBytes?: number;
  workspaceTargetName?: string;
  workspaceTargetUri?: vscode.Uri;
  toWebviewUri?: (resource: vscode.Uri) => vscode.Uri;
  companionPdfUri?: vscode.Uri;
  trustState?: WorkspaceTrustState;
}

export interface KadyPreviewRenderResult {
  format: PreviewFormat;
  heading: string;
  bodyHtml: string;
  bodyIsHtml: true;
}

export async function renderKadyPreview(input: KadyPreviewRenderInput): Promise<KadyPreviewRenderResult> {
  const extension = getResourceExtension(input.resource);
  const name = basename(input.resource);

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return {
      format: "markdown",
      heading: `${name} • Markdown preview`,
      bodyHtml: renderMarkdownPreview(input),
      bodyIsHtml: true,
    };
  }

  if (LATEX_EXTENSIONS.has(extension)) {
    return {
      format: "latex",
      heading: `${name} • LaTeX preview`,
      bodyHtml: renderLatexPreview(input),
      bodyIsHtml: true,
    };
  }

  if (CSV_EXTENSIONS.has(extension)) {
    return {
      format: "table",
      heading: `${name} • ${extension === ".tsv" ? "TSV" : "CSV"} table preview`,
      bodyHtml: renderDelimitedTablePreview(input.content, extension === ".tsv" ? "\t" : ",", extension === ".tsv" ? "TSV" : "CSV"),
      bodyIsHtml: true,
    };
  }

  if (FASTA_EXTENSIONS.has(extension)) {
    return {
      format: "fasta",
      heading: `${name} • FASTA preview`,
      bodyHtml: renderSequencePreview(input.content, false),
      bodyIsHtml: true,
    };
  }

  if (FASTQ_EXTENSIONS.has(extension)) {
    return {
      format: "fastq",
      heading: `${name} • FASTQ preview`,
      bodyHtml: renderSequencePreview(input.content, true),
      bodyIsHtml: true,
    };
  }

  if (BCF_EXTENSIONS.has(extension)) {
    return {
      format: "bcf",
      heading: `${name} • BCF preview`,
      bodyHtml: renderBcfPreview(input),
      bodyIsHtml: true,
    };
  }

  if (BIO_TABLE_EXTENSIONS.has(extension)) {
    return {
      format: "bio-table",
      heading: `${name} • ${(extension.slice(1) || "bio").toUpperCase()} preview`,
      bodyHtml: renderBioTablePreview(input.content, extension.slice(1)),
      bodyIsHtml: true,
    };
  }

  return {
    format: "text",
    heading: `${name} • Kady Preview`,
    bodyHtml: renderFallbackPreview(input),
    bodyIsHtml: true,
  };
}

function renderMarkdownPreview(input: KadyPreviewRenderInput) {
  const markdown = createMarkdownRenderer(input);
  const rendered = markdown.render(input.content);
  const stats = summarizeMarkdown(input.content);

  return `
    <div class="preview-stack preview-stack--lg preview-markdown" data-kady-preview-format="markdown">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Open With Kady Preview</span>
          <h2 class="preview-title">Rich Markdown rendering stays opt-in.</h2>
          <p class="preview-copy">Native text editing remains unchanged. This preview adds math, Mermaid, and highlighted code when you explicitly open the file here.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Workspace: ${input.workspaceTargetName ?? "unresolved"}`)}
          ${renderChip(`Words: ${stats.wordCount.toLocaleString()}`)}
          ${renderChip(`Code fences: ${stats.codeFenceCount}`)}
          ${renderChip(`Mermaid blocks: ${stats.mermaidCount}`)}
        </div>
      </section>
      <section class="preview-card preview-markdown__body">
        ${rendered}
      </section>
    </div>
  `;
}

function createMarkdownRenderer(input: KadyPreviewRenderInput) {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code, language) {
      const normalizedLanguage = language.trim().toLowerCase();

      if (normalizedLanguage === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
      }

      const highlighted = normalizedLanguage && hljs.getLanguage(normalizedLanguage)
        ? hljs.highlight(code, { language: normalizedLanguage }).value
        : escapeHtml(code);

      const codeClass = normalizedLanguage ? ` language-${escapeHtml(normalizedLanguage)}` : "";
      return `<pre class="hljs"><code class="hljs${codeClass}">${highlighted}</code></pre>`;
    },
  });

  markdown.use(texmath, {
    delimiters: "dollars",
    engine: {
      renderToString(expression: string, options?: Record<string, unknown>) {
        return katex.renderToString(expression, {
          ...(options ?? {}),
          output: "mathml",
          throwOnError: false,
          strict: "ignore",
        });
      },
    },
  });

  const defaultImageRenderer = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const source = token.attrGet("src");

    if (source) {
      const resolvedUri = resolveRelativeResourceUri(input, source);
      if (resolvedUri && input.toWebviewUri) {
        token.attrSet("src", input.toWebviewUri(resolvedUri).toString());
      }
    }

    return defaultImageRenderer
      ? defaultImageRenderer(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };

  return markdown;
}

function renderDelimitedTablePreview(content: string, delimiter: string, label: string) {
  const rows = parseDelimitedRows(content, delimiter);

  if (rows.length === 0) {
    return renderEmptyState(`${label} preview`, "No rows were found in this table.");
  }

  const header = rows[0];
  const body = rows.slice(1, 501);

  return `
    <div class="preview-stack" data-kady-preview-format="table">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Structured table preview</span>
          <h2 class="preview-title">${escapeHtml(label)} rows rendered inside the webview.</h2>
          <p class="preview-copy">The preview keeps the default editor intact and gives you a quick read-only table layout for scanning tabular data.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Rows: ${rows.length.toLocaleString()}`)}
          ${renderChip(`Columns: ${header.length.toLocaleString()}`)}
          ${body.length < rows.length - 1 ? renderChip("Preview cap: 500 rows") : ""}
        </div>
      </section>
      <section class="preview-card preview-table-card">
        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${body.map((row) => `<tr>${row.map((cell) => `<td title="${escapeAttribute(cell)}">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderSequencePreview(content: string, isFastq: boolean) {
  const records = parseSequenceRecords(content, isFastq);

  if (records.length === 0) {
    return renderEmptyState(isFastq ? "FASTQ preview" : "FASTA preview", "No sequence records were detected in this file.");
  }

  const visibleRecords = records.slice(0, 20);
  const totalLength = records.reduce((sum, record) => sum + record.sequence.length, 0);

  return `
    <div class="preview-stack" data-kady-preview-format="${isFastq ? "fastq" : "fasta"}">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Bioinformatics preview</span>
          <h2 class="preview-title">${isFastq ? "FASTQ" : "FASTA"} records rendered inline.</h2>
          <p class="preview-copy">Sequence browsing stays read-only here so native editing remains the default path for source changes.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Records: ${records.length.toLocaleString()}`)}
          ${renderChip(`Residues: ${totalLength.toLocaleString()}`)}
          ${isFastq ? renderChip("Quality bars enabled") : renderChip("Sequence coloring enabled")}
        </div>
      </section>
      <section class="preview-stack">
        ${visibleRecords.map((record) => renderSequenceRecord(record, isFastq)).join("")}
        ${records.length > visibleRecords.length ? `<div class="preview-card preview-note">Showing the first ${visibleRecords.length} records to keep the preview responsive.</div>` : ""}
      </section>
    </div>
  `;
}

function renderSequenceRecord(record: SequenceRecord, isFastq: boolean) {
  const sequenceType = detectSequenceType(record.sequence);
  const gcContent = sequenceType === "dna" || sequenceType === "rna"
    ? `${calculateGcContent(record.sequence).toFixed(1)}% GC`
    : "Protein / mixed sequence";

  return `
    <article class="preview-card preview-sequence-card">
      <header class="preview-sequence-header">
        <div>
          <h3 class="preview-sequence-id">${escapeHtml(record.id)}</h3>
          ${record.description ? `<p class="preview-sequence-description">${escapeHtml(record.description)}</p>` : ""}
        </div>
        <div class="preview-chip-row">
          ${renderChip(sequenceType.toUpperCase())}
          ${renderChip(`${record.sequence.length.toLocaleString()} residues`) }
          ${renderChip(gcContent)}
        </div>
      </header>
      <div class="preview-sequence-body">
        <code class="preview-sequence">${renderColoredSequence(record.sequence, sequenceType)}</code>
        ${isFastq && record.quality ? `<div class="preview-quality">${renderQualityBars(record.quality)}</div>` : ""}
      </div>
    </article>
  `;
}

function renderBioTablePreview(content: string, extension: string) {
  const { headers, metaLines, rows } = parseBioTable(content, extension);

  if (rows.length === 0) {
    return renderEmptyState(`${extension.toUpperCase()} preview`, "No data rows were detected in this bioinformatics table.");
  }

  return `
    <div class="preview-stack" data-kady-preview-format="bio-table">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Bundled bio table preview</span>
          <h2 class="preview-title">${escapeHtml(extension.toUpperCase())} rows rendered in a table-oriented layout.</h2>
          <p class="preview-copy">Metadata stays available above the table and the preview remains an explicit read-only surface.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Rows: ${rows.length.toLocaleString()}${rows.length >= 1000 ? "+" : ""}`)}
          ${renderChip(`Columns: ${headers.length.toLocaleString()}`)}
          ${metaLines.length ? renderChip(`Metadata lines: ${metaLines.length}`) : ""}
        </div>
      </section>
      ${metaLines.length ? `<details class="preview-card"><summary class="preview-summary">Metadata</summary><pre class="preview-pre">${escapeHtml(metaLines.join("\n"))}</pre></details>` : ""}
      <section class="preview-card preview-table-card">
        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${rows.map((row) => `<tr>${row.map((cell) => `<td title="${escapeAttribute(cell)}">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderBcfPreview(input: KadyPreviewRenderInput) {
  const rawBytes = input.rawBytes ?? new Uint8Array();
  const sizeBytes = input.sizeBytes ?? rawBytes.byteLength;
  const signature = Array.from(rawBytes.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
  const asciiSignature = Array.from(rawBytes.slice(0, 4))
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
    .join("");
  const classification = classifyBcfBytes(rawBytes);

  return `
    <div class="preview-stack" data-kady-preview-format="bcf">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Bundled bioinformatics preview</span>
          <h2 class="preview-title">Binary Call Format files get a binary-aware summary.</h2>
          <p class="preview-copy">BCF is binary, so Kady Preview does not pretend it is plain text. This explicit preview shows signature-level metadata, byte size, and container hints while leaving source opening behavior untouched.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Workspace: ${input.workspaceTargetName ?? "unresolved"}`)}
          ${renderChip(`Size: ${formatByteSize(sizeBytes)}`)}
          ${renderChip(`Signature: ${signature || "n/a"}`)}
          ${renderChip(classification.label)}
        </div>
      </section>
      <section class="preview-card preview-bcf-grid">
        <div class="preview-stack">
          <h3 class="preview-subtitle">Container summary</h3>
          <p class="preview-copy">${escapeHtml(classification.summary)}</p>
          <dl class="preview-meta-grid">
            <div><dt>First bytes</dt><dd><code>${escapeHtml(signature || "n/a")}</code></dd></div>
            <div><dt>ASCII hint</dt><dd><code>${escapeHtml(asciiSignature || "n/a")}</code></dd></div>
            <div><dt>Byte length</dt><dd>${escapeHtml(sizeBytes.toLocaleString())}</dd></div>
            <div><dt>Interpretation</dt><dd>${escapeHtml(classification.detail)}</dd></div>
          </dl>
        </div>
        <div class="preview-card preview-bcf-note">
          <h3 class="preview-subtitle">Why this preview differs</h3>
          <p class="preview-copy">Task 8 keeps BCF in the supported bioinformatics preview set, but uses a dedicated binary branch rather than a lossy text decode. Full record-level parsing can be layered later without changing the explicit Open With Kady Preview contract.</p>
        </div>
      </section>
    </div>
  `;
}

function renderLatexPreview(input: KadyPreviewRenderInput) {
  const analysis = analyzeLatexDocument(input.content);
  const trustState = input.trustState;
  const compileAllowed = trustState?.capabilities.execute ?? true;
  const pdfUri = input.companionPdfUri && input.toWebviewUri
    ? input.toWebviewUri(input.companionPdfUri).toString()
    : null;

  return `
    <div class="preview-stack preview-stack--lg" data-kady-preview-format="latex">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">LaTeX preview</span>
          <h2 class="preview-title">Compile and inspect rendered output while source editing stays native.</h2>
          <p class="preview-copy">Kady Preview now provides a host-managed compile action, visible status, and log output without replacing the normal VS Code text editor for source changes.</p>
        </div>
        <div class="preview-chip-row">
          ${renderChip(`Document class: ${analysis.documentClass ?? "unknown"}`)}
          ${renderChip(`Sections: ${analysis.sectionCount}`)}
          ${renderChip(`Math blocks: ${analysis.mathBlockCount}`)}
          ${renderChip(pdfUri ? "Existing PDF detected" : "Compile to produce PDF")}
        </div>
      </section>
      <section class="preview-card preview-latex-layout">
        <div class="preview-stack">
          <h3 class="preview-subtitle">Compile status</h3>
          <p class="preview-copy" data-latex-status>${compileAllowed
            ? pdfUri
              ? "A same-directory PDF artifact is already available. Re-run compile to refresh it through the extension host."
              : "No PDF has been produced yet. Choose an engine and compile through the host-managed preview action."
            : "Restricted Mode blocks compile because it is an execute-class capability. Trust the workspace to enable LaTeX compilation."}</p>
          <div class="preview-latex-controls">
            <label class="preview-field">
              <span class="preview-field__label">Engine</span>
              <select class="preview-select" data-latex-engine ${compileAllowed ? "" : "disabled"}>
                <option value="pdflatex">pdfLaTeX</option>
                <option value="xelatex">XeLaTeX</option>
                <option value="lualatex">LuaLaTeX</option>
              </select>
            </label>
            <button class="button" type="button" data-latex-compile ${compileAllowed ? "" : "disabled"}>Compile</button>
          </div>
          <div class="preview-card preview-log-card">
            <div class="preview-log-header">
              <h3 class="preview-subtitle">Compile log</h3>
              <span class="chip" data-latex-command>Host-managed</span>
            </div>
            <pre class="preview-pre" data-latex-log>${escapeHtml(pdfUri
              ? "Ready to recompile. The latest known PDF is shown alongside this log panel."
              : "No compile has been run from Kady Preview yet.")}</pre>
          </div>
          <details class="preview-card">
            <summary class="preview-summary">Document outline</summary>
            <ul class="preview-list">
              ${analysis.sections.length
                ? analysis.sections.map((section) => `<li>${escapeHtml(section)}</li>`).join("")
                : "<li>No section commands detected yet.</li>"}
            </ul>
          </details>
          <details class="preview-card">
            <summary class="preview-summary">Source excerpt</summary>
            <pre class="preview-pre">${escapeHtml(analysis.sourceExcerpt)}</pre>
          </details>
        </div>
        <div class="preview-card preview-latex-output">
          <h3 class="preview-subtitle">Rendered output</h3>
          <div data-latex-output>
            ${pdfUri
              ? `<iframe class="preview-pdf-frame" src="${escapeAttribute(pdfUri)}#toolbar=0&navpanes=0" title="Rendered PDF preview"></iframe>`
              : `<div class="preview-empty-output">Compile output will appear here after a successful host-managed LaTeX build.</div>`}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderFallbackPreview(input: KadyPreviewRenderInput) {
  return `
    <div class="preview-stack" data-kady-preview-format="fallback">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Kady Preview</span>
          <h2 class="preview-title">This file type does not have a richer bundled renderer yet.</h2>
          <p class="preview-copy">The preview remains explicit and read-only so native VS Code editors keep handling normal file opening.</p>
        </div>
      </section>
      <section class="preview-card">
        <pre class="preview-pre">${escapeHtml(input.content.slice(0, 4000))}</pre>
      </section>
    </div>
  `;
}

function renderEmptyState(title: string, body: string) {
  return `
    <div class="preview-stack">
      <section class="preview-banner">
        <div>
          <span class="eyebrow">Kady Preview</span>
          <h2 class="preview-title">${escapeHtml(title)}</h2>
          <p class="preview-copy">${escapeHtml(body)}</p>
        </div>
      </section>
    </div>
  `;
}

function summarizeMarkdown(content: string) {
  return {
    wordCount: content.trim() ? content.trim().split(/\s+/u).length : 0,
    codeFenceCount: (content.match(/```/g) ?? []).length / 2,
    mermaidCount: (content.match(/```\s*mermaid/gi) ?? []).length,
  };
}

function parseDelimitedRows(content: string, delimiter: string) {
  const rows: string[][] = [];

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    if (delimiter === "\t") {
      rows.push(line.split("\t"));
      continue;
    }

    const row: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (inQuotes) {
        if (character === '"' && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else if (character === '"') {
          inQuotes = false;
        } else {
          current += character;
        }
        continue;
      }

      if (character === '"') {
        inQuotes = true;
      } else if (character === delimiter) {
        row.push(current);
        current = "";
      } else {
        current += character;
      }
    }

    row.push(current);
    rows.push(row);
  }

  return rows;
}

interface SequenceRecord {
  id: string;
  description: string;
  sequence: string;
  quality?: string;
}

function parseSequenceRecords(content: string, isFastq: boolean) {
  return isFastq ? parseFastq(content) : parseFasta(content);
}

function parseFasta(content: string) {
  const records: SequenceRecord[] = [];
  let current: SequenceRecord | null = null;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (line.startsWith(">")) {
      if (current) {
        records.push(current);
      }

      const header = line.slice(1).trim();
      const [id, ...rest] = header.split(/\s+/u);
      current = { id: id ?? "sequence", description: rest.join(" "), sequence: "" };
      continue;
    }

    if (current) {
      current.sequence += line;
    }
  }

  if (current) {
    records.push(current);
  }

  return records;
}

function parseFastq(content: string) {
  const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);
  const records: SequenceRecord[] = [];

  for (let index = 0; index + 3 < lines.length; index += 4) {
    const header = lines[index];
    const sequence = lines[index + 1] ?? "";
    const quality = lines[index + 3] ?? "";

    if (!header.startsWith("@")) {
      continue;
    }

    const trimmedHeader = header.slice(1).trim();
    const [id, ...rest] = trimmedHeader.split(/\s+/u);
    records.push({
      id: id ?? "read",
      description: rest.join(" "),
      sequence,
      quality,
    });
  }

  return records;
}

function detectSequenceType(sequence: string) {
  const normalized = sequence.toUpperCase();

  if (/^[ACGTN]+$/u.test(normalized)) {
    return "dna";
  }

  if (/^[ACGUN]+$/u.test(normalized)) {
    return "rna";
  }

  return "protein";
}

function calculateGcContent(sequence: string) {
  const normalized = sequence.toUpperCase();
  const gcCount = Array.from(normalized).filter((base) => base === "G" || base === "C").length;
  return normalized.length ? (gcCount / normalized.length) * 100 : 0;
}

function renderColoredSequence(sequence: string, sequenceType: string) {
  const characters = Array.from(sequence.slice(0, 240));
  const colorMap = sequenceType === "protein" ? AA_BASE_COLORS : DNA_BASE_COLORS;
  const suffix = sequence.length > 240
    ? `<span class="preview-sequence-more">… +${(sequence.length - 240).toLocaleString()} more</span>`
    : "";

  return `${characters.map((character) => {
    const cssClass = colorMap[character.toUpperCase()] ?? "preview-base--unknown";
    return `<span class="${cssClass}">${escapeHtml(character)}</span>`;
  }).join("")}${suffix}`;
}

function renderQualityBars(quality: string) {
  return Array.from(quality.slice(0, 120)).map((character) => {
    const score = character.charCodeAt(0) - 33;
    const bucket = score >= 30 ? "preview-quality-bar--high" : score >= 20 ? "preview-quality-bar--mid" : "preview-quality-bar--low";
    const height = Math.max(6, Math.min(24, Math.round((score / 40) * 24)));
    return `<span class="preview-quality-bar ${bucket}" style="height:${height}px" title="Q${score}"></span>`;
  }).join("");
}

function parseBioTable(content: string, extension: string) {
  const lines = content.split(/\r?\n/u);
  const metaLines: string[] = [];
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith("##")) {
      metaLines.push(line);
      continue;
    }

    dataLines.push(line);
  }

  if (dataLines.length === 0) {
    return { headers: [], metaLines, rows: [] as string[][] };
  }

  let headers: string[] = [];
  let startIndex = 0;

  if (dataLines[0].startsWith("#")) {
    headers = dataLines[0].slice(1).split("\t").map((cell) => cell.trim());
    startIndex = 1;
  } else {
    headers = BIO_TABLE_DEFAULT_HEADERS[extension] ?? [];
  }

  const rows = dataLines.slice(startIndex, startIndex + 1000).map((line) => line.split("\t"));
  return { headers, metaLines, rows };
}

function analyzeLatexDocument(content: string) {
  const sourceLines = content.split(/\r?\n/u);
  const documentClassMatch = content.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/u);
  const sections = Array.from(content.matchAll(/\\(?:section|subsection|subsubsection)\*?\{([^}]+)\}/gu)).map((match) => match[1]);

  return {
    documentClass: documentClassMatch?.[1],
    sections,
    sectionCount: sections.length,
    mathBlockCount: (content.match(/\$\$[\s\S]*?\$\$/gu) ?? []).length + (content.match(/\\\[[\s\S]*?\\\]/gu) ?? []).length,
    sourceExcerpt: sourceLines.slice(0, 80).join("\n"),
  };
}

function classifyBcfBytes(rawBytes: Uint8Array) {
  if (rawBytes.length >= 5 && rawBytes[0] === 0x42 && rawBytes[1] === 0x43 && rawBytes[2] === 0x46) {
    const major = rawBytes[3];
    const minor = rawBytes[4];
    return {
      label: `BCF signature detected`,
      summary: `The byte stream starts with the BCF magic header (version ${major}.${minor}).`,
      detail: `Native BCF header bytes were detected directly in the file payload.`,
    };
  }

  if (rawBytes.length >= 18 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b) {
    const isBgzf = rawBytes[12] === 0x42 && rawBytes[13] === 0x43;
    return {
      label: isBgzf ? "BGZF-wrapped binary payload" : "Gzip-compressed binary payload",
      summary: isBgzf
        ? "The file starts with a BGZF-compatible gzip header, which is the expected container for many BCF files."
        : "The file starts with a gzip header, indicating compressed binary content.",
      detail: isBgzf
        ? "The BC extra subfield was found in the gzip header, suggesting a BGZF block structure."
        : "The preview can confirm binary compression but not a BGZF subfield in the first header bytes.",
    };
  }

  return {
    label: "Binary payload detected",
    summary: "The file did not expose a plain-text header and is being treated as a binary BCF-like payload.",
    detail: "Kady Preview is showing byte-level metadata rather than attempting a lossy text decode.",
  };
}

function formatByteSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveRelativeResourceUri(input: KadyPreviewRenderInput, source: string) {
  if (isAbsoluteWebSource(source)) {
    return undefined;
  }

  const normalizedSource = source.startsWith("/") ? source.slice(1) : source;
  const baseUri = source.startsWith("/")
    ? input.workspaceTargetUri ?? directoryUri(input.resource)
    : directoryUri(input.resource);

  return vscode.Uri.joinPath(baseUri, ...normalizedSource.split("/"));
}

function isAbsoluteWebSource(source: string) {
  return /^https?:\/\//iu.test(source) || source.startsWith("data:") || source.startsWith("mailto:");
}

function getResourceExtension(resource: vscode.Uri) {
  const name = basename(resource).toLowerCase();
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex >= 0 ? name.slice(extensionIndex) : "";
}

export function basename(resource: vscode.Uri) {
  const segments = resource.path.split("/").filter(Boolean);
  return segments.at(-1) ?? resource.authority ?? resource.scheme;
}

export function directoryUri(resource: vscode.Uri) {
  const segments = resource.path.split("/");
  segments.pop();
  const nextPath = segments.join("/") || "/";
  return resource.with({ path: nextPath.endsWith("/") && nextPath !== "/" ? nextPath.slice(0, -1) : nextPath });
}

function renderChip(label: string) {
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
