# Basic usage

This guide covers everything you need for day-to-day work with Kady, your AI research assistant. It assumes you've already [installed the app](./installation.md) and have it open at [http://localhost:3000](http://localhost:3000).

## Your first session

1. **Create a project.** Each project is a self-contained workspace with its own files, chat history, and settings. Think of one project per study, paper, or analysis.
2. **Upload your data** (optional). Drag files into the file browser on the left, or drop them directly onto the message box. CSVs, PDFs, notebooks, genomics tables, molecular structures, mass spectra, imaging volumes — [60+ scientific formats](./file-previews.md) are recognized and previewable.
3. **Ask for what you want in plain language.** For example:
   - *"Run a differential expression analysis on counts.csv comparing treated vs control, and plot a volcano plot."*
   - *"Summarize the methods sections of these three PDFs and compare their statistical approaches."*
   - *"Find recent literature on CRISPR off-target prediction and write a one-page overview with citations."*

Kady works like a researcher at a computer: it reads and writes files, runs code, searches the web, and reports back. You'll see its progress live in the chat, and any files it produces appear in the file browser, ready to preview or download.

## How Kady works on a task

- **It asks before it assumes.** When a task is ambiguous, Kady pauses and shows an interactive question form right in the chat — multiple choice with recommended answers, free text, even image upload. Confirm its suggestions in one click or skip the form entirely.
- **It runs real code.** Analyses happen in your project's sandbox using Python (managed automatically with [uv](https://docs.astral.sh/uv/)). You can ask to see the code, modify it, or re-run it.
- **It activates the right skills.** 140+ pre-installed scientific skills cover genomics, proteomics, drug discovery, materials science, and more. Kady picks the relevant ones automatically — you don't need to choose.
- **It can delegate to specialists.** Kady has a built-in team of 21 scientific sub-agents — a `citation-checker` that verifies every reference, a `statistical-reviewer` that audits your analysis, a `peer-reviewer` that writes a journal-style report, and 18 more. Kady delegates on its own for heavy or parallel work, or you can name one yourself: *"have the citation-checker go through manuscript.md"*. See [Sub-agents](./sub-agents.md).
- **It can search the web and read sources.** Kady (and every sub-agent) can search the web, fetch and read pages, PDFs, and entire GitHub repositories, and even understand YouTube videos — out of the box, no extra key required. Optional Exa, Perplexity, and Gemini keys unlock the direct providers (see [Installation → Optional API keys](./installation.md#6-optional-api-keys)).

## The interface

### Chat tabs — up to 10 parallel chats

Click `+` in the chat tab strip to open a new chat in the same project. Each tab keeps its own message history, model choice, attached files, and cost meter — but all tabs share the project's files, so results from one chat are immediately available in the others. Tabs keep working in the background while you switch between them. Double-click a tab title to rename it; closing a tab cancels any work it had running.

### Choosing a model

Use the model dropdown in the input bar. Any message can use any tool-capable model from OpenRouter (OpenAI, Anthropic, Google, xAI, Qwen, and more), or a free local model through [Ollama](./local-models-ollama.md). Different tabs can use different models. See [Model selection](./model-selection.md) for how the list is built.

### Files

- **Upload:** drag files into the file browser or onto the input bar.
- **Reference:** type `@filename` in a message to point Kady at a specific file.
- **Preview:** click any file for a built-in viewer — code, Markdown (with math and diagrams), CSVs, PDFs, images, and Jupyter notebooks, plus a broad set of scientific formats: genomics (FASTA/FASTQ, VCF, BED/GFF/SAM, alignments, phylogenetic trees), chemistry (SMILES/MOL/SDF 2D depictions, interactive 3D PDB/mmCIF structures), mass spectra (mzML/MGF/JCAMP), data arrays (AnnData, HDF5, Parquet, NumPy, NetCDF), and bio-imaging (DICOM, NIfTI, TIFF). See the [full list](./file-previews.md).
- **Download:** grab any result straight from the file browser.

### Workflow templates

Open the workflows panel to browse **326 ready-to-run templates across 22 disciplines** — genomics, drug discovery, finance, astrophysics, and more. Pick one, fill in the blanks, and click Launch; it runs in the currently active chat tab. Want to add your own? See [Contributing workflows](./contributing-workflows.md).

### Scientific databases

Kady can query **229 scientific and financial databases** across 18 categories — Biomedical & Health, Chemistry & Materials, Scholarly Publications, Stock Market, Earth & Climate, Astronomy & Space, and more. Just ask (*"look up this compound in PubChem"*); Kady knows how to reach them. A few databases need their own free API key, listed in `.env.example`.

### LaTeX editor

Open any `.tex` file for a split-pane editor with live PDF compilation (pdfLaTeX, XeLaTeX, LuaLaTeX) — handy for writing up results without leaving the app.

### Other input options

- **Voice input** — dictate your message instead of typing.
- **Message queue** — keep typing while Kady works; up to 5 messages queue and run in order.

## Costs and budgets

You pay only for what the AI models consume on your own API key. The cost pill in the header shows the active tab's session cost (`sess`) and the project total across every tab (`proj`). You can set an optional hard spend cap per project in Settings, and using local Ollama models costs nothing at all.

## Settings

Click the gear icon in the top-right to:

- manage your **API keys**,
- connect external tools via **[MCP servers](./mcp-servers.md)** — GitHub, reference managers, databases, and hundreds more, with a built-in connection tester,
- view, edit, and create **[sub-agents](./sub-agents.md)**,
- change the appearance.

## Tips for good results

- **Give context.** "Analyze my data" works, but "Compare expression between the 3 treated and 3 control samples in counts.csv; genes are rows" works much better.
- **Work iteratively.** Ask for a first pass, look at the output, then refine — just like working with a colleague.
- **Use projects to stay organized.** One project per paper or study keeps files and chat history together.
- **Check the rough edges.** This is a beta — see [Known limitations](./limitations.md) for what to watch out for.
