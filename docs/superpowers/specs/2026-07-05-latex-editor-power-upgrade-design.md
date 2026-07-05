# LaTeX Editor Power Upgrade — Design

**Date:** 2026-07-05
**Status:** Approved pending user review

## Goal

Turn the built-in LaTeX editor into a power editor: fix known bugs, add the
feature set users expect from a serious LaTeX IDE (autocomplete, outline,
SyncTeX, spell check), optimize browser and server performance, and integrate
AI assistance (fix errors, transform selections, hand off to Kady chat).

## Current state

- `web/src/components/latex-editor.tsx` (~400 lines): CodeMirror 6, TeX
  syntax, hardcoded `githubLight` theme, autocompletion disabled, iframe PDF
  preview that fully remounts on every compile.
- `POST /sandbox/compile-latex` uses **`spawnSync`** (blocks the Node event
  loop up to 60 s), latexmk when present, single-pass fallback otherwise.
- Compile errors parsed into gutter diagnostics; warnings dropped.
- A capable shared pdf.js viewer already exists
  (`web/src/components/pdf-viewer/`: zoom, IntersectionObserver lazy page
  rendering, annotation layer) but the LaTeX editor predates it and doesn't
  use it.

## Bugs fixed (independent of new features)

1. **Event-loop blocking compile** — replace `spawnSync` with async `spawn`.
2. **No dark mode** — editor follows `next-themes` via a CodeMirror
   compartment (`githubLight`/`githubDark`). Same fix applied to the generic
   text editor in `file-preview-panel.tsx`.
3. **Linter O(n) per lint pass** — compare CodeMirror `Text` objects with
   `.eq()` instead of `doc.toString()` string comparison.
4. **Keystroke re-render storm** — document content moves out of React state
   into CodeMirror state + a ref; only an `isDirty` boolean triggers React
   updates.
5. **Double-fire compile** — ⌘↵ guarded while a compile is in flight;
   server coalesces duplicate compile requests per target file.
6. **Single-pass fallback** — without latexmk: engine → bibtex/biber (when
   the doc references a bibliography) → engine ×2, so cross-refs and
   bibliographies resolve.
7. **Warnings dropped** — undefined references, citations, and overfull-box
   warnings become warning-severity diagnostics.
8. **Hardcoded ⌘ labels** — platform-aware shortcut labels (Ctrl elsewhere).
9. **Divider drag select-none** — `dragging` becomes state-effective so text
   selection is actually suppressed during drag.

## Architecture

### Frontend module split

`latex-editor.tsx` becomes a thin shell over a new module, loaded with
`next/dynamic` so its weight stays out of the main preview bundle:

```
web/src/components/latex/
├── latex-editor.tsx      # shell: toolbar, split pane, state orchestration
├── latex-toolbar.tsx     # compile/engine/save + snippet inserts + AI/Kady buttons
├── outline-panel.tsx     # collapsible sidebar: sections/figures/tables; breadcrumb
├── latex-pdf-pane.tsx    # wraps shared PdfViewer; scroll-preserving reload + SyncTeX
├── ai-edit-popover.tsx   # Cmd+K instruction input + inline diff accept/reject
└── log-panel.tsx         # compile log with error/warning filtering

web/src/lib/latex/
├── outline.ts            # doc → outline tree (debounced, tested)
├── diagnostics.ts        # log parsing (errors + warnings), moved out & extended
├── completions.ts        # command/env/snippet sources; \ref & \cite scanners
├── spellcheck.ts         # CM extension; Web Worker + typo-js, skips commands/math
└── magic-comments.ts     # % !TEX root / program detection
```

### Server

All in `server/src/api/sandbox.ts` plus one new module:

- **Compile (async):** `spawn` with existing timeout/maxBuffer semantics;
  adds `-synctex=1`. A per-target in-flight map coalesces duplicate requests
  (second caller awaits the first's result). Child processes killed on
  timeout. `% !TEX root` is resolved client-side (client sends the root
  path); server keeps its `safePath` validation.
- **`GET /sandbox/synctex`** — `dir=forward&path=<tex>&line=` returns PDF
  page + rect; `dir=inverse&pdf=<pdf>&page=&x=&y=` returns tex file + line.
  Shells out async to the `synctex` CLI (ships with TeX Live); output parsed
  into JSON. Missing binary or missing `.synctex.gz` → structured 4xx the
  client uses to disable sync UI.
- **`POST /sandbox/latex-assist`** — one-shot `complete()` from
  `@earendil-works/pi-ai` via the existing `resolveModel()` path (defaults
  to `DEFAULT_MODEL_ID`, accepts optional `model` ref). Modes:
  - `fix`: `{ error, contextBefore/After, preamble }` → replacement snippet
    for a stated line range.
  - `edit`: `{ selection, instruction, preamble }` → rewritten selection.
  Gated by `isBudgetExceeded()` before the call; usage ledgered under
  synthetic session id `latex-assist` so it appears in project cost
  summaries and counts toward `spendLimitUsd`.

## Editor features

- **Autocomplete** (currently disabled) — three merged sources:
  1. ~200 common commands + math symbols with signatures.
  2. Environment names after `\begin{`, auto-inserting the matching
     `\end{}`.
  3. Context-aware `\ref{…}` from `\label{}`s in the doc (and the
     `!TEX root` doc when set); `\cite{…}` keys parsed from the `.bib`
     files the doc references (fetched once via the sandbox read API,
     cached until recompile).
  Plus snippets: figure/table/equation/itemize skeletons.
- **Spell check** — Web Worker running typo-js with a bundled en_US
  dictionary (`web/public/`). Only prose is checked; commands, math,
  comments, and the preamble are skipped using the syntax tree. Red
  squiggles; hover/right-click offers suggestions and "add to dictionary"
  (per-project, localStorage).
- **Outline panel** — toggleable, left of the editor:
  sections/subsections/figures/tables/labels, click to jump. Toolbar
  breadcrumb shows the current section. Parsed on a 300 ms debounce.
- **QoL** — auto-compile-on-save toggle, live prose word count, log panel
  "errors/warnings only" filter.

## PDF pane

Replaces the iframe with the shared `PdfViewer`, extended with three optional
props (LaTeX editor is the only consumer; annotation flows untouched):

- `reloadToken` — re-fetch the document in place; restore scroll/zoom after
  the new render; old canvases stay until replacements paint (no flash).
- `syncHighlight` — page + rect to scroll to and flash.
- `onSyncClick` — Cmd/Ctrl+click handler receiving PDF-space coordinates.

**Forward sync:** button + keybinding, cursor line → synctex forward →
scroll + flash. **Inverse sync:** Cmd/Ctrl+click in PDF → synctex inverse →
editor scrolls to line and pulses it; if the target is a different file, it
opens via existing preview-panel navigation.

## AI features

- **Fix with AI** — action on each inline diagnostic and each log-panel
  error row. Sends error + ±40 lines of context + preamble. Response
  rendered as an inline unified diff (`@codemirror/merge`) with
  Accept/Reject. Nothing auto-applies.
- **AI edit (Cmd+K)** — with a selection, popover takes an instruction;
  rewrite comes back as the same accept/reject diff.
- **Ask Kady** — toolbar button dispatches a `kady:prefill-chat`
  CustomEvent; the active chat composer (new, small listener) is prefilled
  with a reference to the open file and focused. The agent reads sandbox
  files itself — no content shipping.
- Cost of each assist call shown after completion; budget-exceeded uses the
  same messaging as chat runs. In-flight calls cancellable.

## Error handling

- **Compile:** explicit messages for timeout / missing binary / no latexmk
  are kept; coalescing prevents process pile-up; timeout kills the child.
- **SyncTeX:** missing `.synctex.gz` or binary → sync UI disabled with an
  explanatory tooltip; never an error-toast loop.
- **AI:** model errors render in the popover with retry; unextractable
  model output shows "couldn't produce a clean edit" with raw text
  expandable; never silently applied.
- **Spellcheck/outline:** failures disable the feature for the session
  (console log), editor keeps working.

## Performance summary

- Server: async compile (no event-loop blocking), request coalescing.
- Editor: no per-keystroke React re-render; `.eq()` doc comparison; theme
  swap via compartment (no editor re-creation); spellcheck off-thread;
  outline debounced.
- Bundle: LaTeX module (incl. dictionary, merge view) lazy-loaded via
  `next/dynamic`.
- PDF: existing lazy page rendering retained; in-place reload preserves
  scroll/zoom and avoids full remount.

## Testing

- **web (vitest):** outline parser; diagnostics parser (error + warning
  fixtures from real logs); completion sources (`\ref`/`\cite` scanning);
  magic-comment parsing; diff-application logic.
- **server (vitest):** synctex output parsing; latex-assist prompt assembly
  + response extraction; ledger row writing; budget gating (mocked model);
  compile coalescing. Compile/synctex integration tests run only when
  `pdflatex` is on PATH (skipped in CI).
- Manual verification with a real multi-file paper + bibliography.

## Out of scope

- AI ghost-text inline completion (rejected: token cost, debounce
  complexity).
- In-browser WASM TeX compilation (rejected: 30–60 MB assets, package
  coverage gaps, diverges from the TeX Live the agent uses).
- Grammar checking, collaborative editing, Git integration for .tex files.
