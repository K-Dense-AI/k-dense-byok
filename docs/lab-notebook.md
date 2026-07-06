# Living Lab Notebook

Kady's Living Lab Notebook is a real-time record of its work on your project. As Kady runs analyses, writes code, and makes decisions, it automatically logs structured entries to a center-panel "Lab Notebook" tab in the chat interface. You can watch entries appear as they're authored, review them later, export the full log, or print it as a PDF.

## What gets logged

Kady logs entries through the `notebook` tool when it wants to record its work. Each entry can include:

- **Title** — a short name for the entry
- **Type** — one of: `hypothesis` (a testable assumption), `method` (a procedure), `observation` (findings or results), `decision` (a choice made), or `note` (miscellaneous)
- **Body** — optional Markdown text with details, context, or explanation
- **Code snippet** — optional code block (e.g., a command that was run or a config used)
- **Confidence** — optional rating (`low`, `medium`, `high`) for hypotheses or observations
- **Tags** — optional keywords for filtering or grouping
- **Artifacts** — optional sandbox-relative file paths (e.g., `data/analysis.csv`); each appears as a clickable chip that opens the file in the preview panel

Entries are author-stamped and timestamped automatically.

## Where it lives

Entries persist as a JSON Lines file (one entry per line) at:
```
sandbox/.kady/notebook/<sessionId>.jsonl
```

Each chat tab (session) has its own notebook; closing the tab does not delete entries — they remain in the project's sandbox and can be reopened from the session history.

## In the UI

- **Center-panel tab.** An always-pinned "Lab Notebook" tab appears next to file-preview tabs in the center panel, fed live from the active chat tab's stream.
- **Real-time streaming.** As Kady writes entries, they appear in the notebook with a pulsing "writing…" indicator.
- **Auto-scroll.** The view scrolls to the newest entry as they arrive.
- **Empty state.** Before any entries are logged, the notebook shows a friendly message.

## Export and print

- **Markdown export.** The notebook view has an "Export as Markdown" button that downloads a file with a header, per-entry sections, embedded figures from artifacts, and inline code.
- **PDF.** Use your browser's print dialog (Cmd+P on Mac, Ctrl+P on Windows/Linux) from the notebook view to save as PDF, or print to a printer.

## Behind the scenes

The `notebook` tool is a **non-blocking** in-process agent tool. When Kady logs an entry, the tool returns immediately — it does not pause the run. Each entry arrives in the chat UI as a `tool_start` SSE frame (the same framing used by other tools like `interview`), so entry metadata rides the normal streaming channel without requiring any new message types.

## Caveats

- **Lead agent only.** The `notebook` tool is available only to the lead agent in the primary chat tab. Sub-agent child processes (spawned by the `subagent` tool) do not see it — entries from subagents are not logged to the notebook in the current version. A future extension could promote the tool to a Pi package to expose it to subagents and render entries in per-agent lanes.
- **Session-scoped.** Each chat tab keeps its own notebook. Switching between tabs shows different notebooks.
- **Missing artifacts.** If an artifact path no longer exists (e.g., the file was deleted), the chip shows a "not found" state but does not break the entry display or prevent export.

## Examples

A typical data-analysis session might produce entries like:

| Type | Title | Body |
|------|-------|------|
| Hypothesis | Count matrix normalization | Assume DESeq2 size factors improve downstream variance stability |
| Method | Load and preprocess counts | Read the CSV, filter low-abundance genes, apply size-factor normalization |
| Observation | Post-QC gene count | 18,500 genes retained after filtering (started with 28,000) |
| Decision | Use Wald test for DE | Sufficient replicates per group; Wald is faster than LRT and suitable here |
| Note | Volcano plot thresholds | log2FC > ±1.5, adjusted p < 0.05 per convention in the field |

Each entry can include code (the exact command run), artifact links to outputs (e.g., the volcano plot PNG or the normalized count matrix), and a confidence level.
