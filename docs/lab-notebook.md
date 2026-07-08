# Living Lab Notebook

Kady's Living Lab Notebook is a real-time record of its work on your project. As Kady runs analyses, writes code, and makes decisions, it automatically logs structured entries to a center-panel "Lab Notebook" tab in the chat interface. You can watch entries appear as they're authored, thread hypotheses to the evidence that tests them, pin and comment on entries, add your own notes, review past sessions, export the full log (with artifacts), print it as a PDF, or generate a Methods-section draft from it.

## What gets logged

Kady logs entries through the `notebook` tool when it wants to record its work. Each entry can include:

- **Title** — a short name for the entry
- **Type** — one of: `hypothesis` (a testable assumption), `method` (a procedure), `observation` (findings or results), `decision` (a choice made), or `note` (miscellaneous)
- **Body** — optional Markdown text with details, context, or explanation
- **Code snippet** — optional code block rendered with syntax highlighting and a copy button; if the code references a file artifact, an "Open as file" button opens that source file in the preview panel
- **Confidence** — optional rating (`low`, `medium`, `high`), shown as a three-segment meter
- **Tags** — keywords shown as chips; clicking one filters the notebook
- **Artifacts** — sandbox-relative file paths; images render as inline thumbnails, other files as clickable chips that open in the preview panel
- **Links** — an entry can reference an earlier entry (`relatesTo`) with a stance (`supports` / `refutes` / `neutral`), or amend one (`supersedes`)

Entries are author-stamped, timestamped, and stamped with the run that produced them automatically.

## Threading: hypotheses, evidence, amendments

The notebook is more than a log — entries link into an argument structure:

- An **observation** that tests a hypothesis is logged with `relatesTo` pointing at it and a stance. The hypothesis card then shows a live status badge: **open** (no verdict yet), **supported**, or **refuted** (decided by the latest non-neutral linked entry).
- A **decision** can cite the observation that drove it; the reference line under the title (`↳ supports …` / `↳ refutes …`) is clickable and scrolls to the target.
- History is append-only: to correct an entry, Kady logs a new one with `supersedes`. The old card is struck through and dimmed, with links in both directions ("superseded by" / "amends").

## Your layer: pins, comments, and notes

Agent entries are immutable, but you can annotate them:

- **Pin** entries with the star button; a "Pinned" filter chip shows only pinned entries.
- **Comment** on any entry (the comment thread lives under the card).
- **Add your own notes** with the composer at the bottom of the notebook; they appear in the timeline attributed to "You".

Annotations persist in a sidecar file next to the notebook (`.kady/notebook/<sessionId>.annotations.json`) — the agent's record is never modified.

## Where it lives

Entries persist as a JSON Lines file (one entry per line) at:
```
sandbox/.kady/notebook/<sessionId>.jsonl
```

Each chat tab (session) has its own notebook; closing the tab does not delete entries — they remain in the project's sandbox and can be reopened from the session history.

## In the UI

- **Center-panel tab.** An always-pinned "Lab Notebook" tab appears next to file-preview tabs in the center panel, fed live from the active chat tab's stream.
- **Real-time streaming.** As Kady writes entries, they appear in the notebook with a pulsing "writing…" indicator.
- **Timeline rail.** Entries sit on a vertical rail with type-colored nodes. Dividers mark new runs, and day dividers appear when a notebook spans multiple days.
- **Scrolling that respects you.** The view sticks to the newest entry only while you're at the bottom; scroll up to read and it stays put, with a floating button to jump back down.
- **Filters and search.** Header chips filter by type (with live counts); a search box matches titles, bodies, and tags.
- **Two view modes.** "By agent" groups entries into collapsible per-agent lanes (each with a stable accent color); "Timeline" interleaves all agents chronologically with a per-entry author badge.
- **Scope toggle.** "This chat" shows the active session; "All chats" shows a read-only merged timeline of every session in the project, with session dividers.
- **Chat ↔ notebook links.** Notebook writes appear in the chat transcript as compact chips with "View in notebook"; each notebook card has a "View in chat" button that scrolls the transcript to the moment it was logged. Both directions flash the target.

## Subagent lanes

The notebook groups entries into collapsible per-agent lanes. The lead agent's entries appear in the "Kady (lead)" lane first, followed by a lane for each subagent that contributed entries (labeled by agent name, with an entry count and accent color).

Subagent entries are harvested when the subagent finishes, as a batch, not live. While async/background subagent work is outstanding, the notebook polls every few seconds so late entries surface without a reload.

**Limitation:** Nested subagents (depth > 1) are not harvested in this version — only direct children contribute.

## Export and print

The header's **Export** menu offers:

- **Markdown (.md)** — a lab record with attribution, tags, confidence, and thread links per entry.
- **Bundle with artifacts (.zip)** — the Markdown plus every referenced artifact file under `artifacts/`, with links rewritten so figures resolve inside the bundle. Missing artifacts are noted rather than breaking the export.
- **JSON (.json)** — the raw entries for programmatic use.

The **PDF** button opens a print-ready view — Markdown bodies fully rendered, figures embedded, lanes, threading, pins, and comments included — and triggers your browser's print dialog. If your browser blocks the popup, a notification tells you.

## Methods draft

The **Methods draft** button (with a confirm step — it makes one AI call billed to your project budget) summarizes the notebook's method, decision, and observation entries into a manuscript-style Methods section. The draft is saved as `methods_draft_<sessionId>.md` in the sandbox and opens in the preview panel. The call is budget-gated and ledgered under the `methods-draft` session id in project costs.

## Behind the scenes

The `notebook` tool is a **non-blocking** in-process agent tool. When Kady logs an entry, the tool returns immediately — it does not pause the run. Each entry arrives in the chat UI as a `tool_start` SSE frame, and a synthetic `run_start` frame carries the run id so live entries group by run before the authoritative refetch. The tool result returns the entry's id so Kady can reference it in later `relatesTo`/`supersedes` links.

## Caveats

- **Subagents log too, but as a batch.** The lead agent gets the `notebook` tool in-process; subagents get it via the vendored `kady-notebook` Pi package, and their entries are harvested into the parent notebook when each child finishes. Builtin `pi-subagents` specialists pin a `tools:` allowlist that would otherwise strip the notebook tool; the backend seeds `subagents.agentOverrides.<name>.tools` to compensate. A user who pins their own `tools` override for a builtin agent takes responsibility for including `notebook`.
- **Run attribution for async children.** An async subagent that finishes while a *later* run of the same session is in flight has its entries attributed to that later run.
- **Session-scoped by default.** Each chat tab keeps its own notebook; the "All chats" scope is read-only (no live stream, pins, or notes there).
- **Missing artifacts.** If an artifact path no longer exists, the chip shows a "not found" state (and zip/Markdown exports note it) without breaking the entry.

## Examples

A typical data-analysis session might produce entries like:

| Type | Title | Links |
|------|-------|-------|
| Hypothesis | Count matrix normalization improves variance stability | — |
| Method | Load and preprocess counts | — |
| Observation | Size factors flatten mean-variance trend | supports → the hypothesis |
| Decision | Use Wald test for DE | relates to → the observation |
| Note | Volcano plot thresholds | — |

Each entry can include code (the exact command run), artifact links to outputs (e.g., the volcano plot PNG), a confidence level, and tags — and the hypothesis card shows **supported** once the observation lands.
