# Kady's Living Lab Notebook — Design Spec

**Date:** 2026-07-05
**Status:** Approved (brainstorming), pending implementation plan
**Author:** Kady brainstorming session

## One-line summary

A center-panel notebook that **writes itself in real time** as Kady works, in the
scientist's own language — **Hypothesis → Method → Observation → Decision** — with
every entry wired to the code and figures that produced it, and exportable as a
real, timestamped lab record.

This is the product's headline "wow": a scientist watches an autonomous
researcher narrate its own investigation as a living lab notebook, then keeps
that notebook as a durable deliverable.

## Why this, and why it's novel

The current chat panel already streams `thinking_delta` and `tool_start/end`
events as a linear transcript. That is a *log*. Scientists don't think in logs;
they think in lab notebooks — structured, dated entries that record intent
(hypothesis), procedure (method), result (observation), and judgment
(decision). No competing agent product turns the agent's *own* reasoning into a
self-writing, cross-linked, exportable lab notebook. That is the never-before-seen
step-change: not prettier text, but a different *form* that speaks the
scientist's native language and doubles as a lasting artifact.

## Decisions locked during brainstorming

1. **Wow dimension:** "Watch it think & work" — make Kady's live scientific
   reasoning + actions visible and trustworthy.
2. **Core metaphor:** Lab-notebook narrative (self-writing structured entries),
   not a spatial graph, team dashboard, or flight-recorder scrubber.
3. **Entry authoring:** The agent authors its own entries via a dedicated
   `notebook` tool — highest fidelity (real intent, not a client-side guess or a
   second model's reconstruction).
4. **Placement:** A first-class view in the **center panel** (where file
   previews live), with its own tab. Chat stays on the right for steering.
5. **Durability:** Durable **and** exportable — persists as an artifact in the
   sandbox and exports to Markdown/PDF as a timestamped, figure-embedded lab
   record.
6. **Build strategy:** Phased flagship (option A). Phases 1–2 are a shippable
   product on their own.

## Architecture overview

The notebook reuses the pattern already proven by the `interview` tool
(`server/src/agent/interview.ts`): an **in-process custom tool** whose payload
rides the normal `tool_start` SSE frame and renders as a bespoke inline UI. The
crucial difference: the notebook tool is **non-blocking** — it validates,
stamps, persists, returns a tiny ack to the model, and the run keeps flowing. It
never awaits the UI.

```
Kady (lead agent)
   │  calls notebook({type, title, body, artifacts, code, ...})
   ▼
notebook tool (server/src/agent/notebook.ts, in-process)
   │  validate (typebox) → stamp id/timestamp/elapsedMs/role
   │  append row → projects/<id>/sandbox/.kady/notebook/<sessionId>.jsonl
   │  return "logged <id>"  (non-blocking)
   ▼
Pi emits tool_execution_start  ──► events.ts ──► SSE tool_start frame
                                                   (tool="notebook", args=entry)
   ▼
Frontend useAgent stream ──► notebook-view.tsx
   │  filter tool_start where tool === "notebook"
   │  merge with GET /sessions/:id/notebook (reload), dedupe by id
   ▼
Center-panel "Notebook" tab: self-writing vertical timeline of entry cards
```

## Data model — the notebook entry

The `notebook` tool accepts **one entry per call**. Schema (typebox, defined the
way `interview` defines its question schema):

| Field | Type | Notes |
|---|---|---|
| `type` | enum: `hypothesis` \| `method` \| `observation` \| `decision` \| `note` | Drives color + icon |
| `title` | string (required) | The card headline (one line) |
| `body` | string (optional) | Markdown detail |
| `artifacts` | string[] (optional) | Sandbox-relative paths this entry produced/references (figures, data, scripts) — powers cross-links |
| `code` | `{ source: string, lang?: string }` (optional) | Inline snippet when the code isn't a saved file |
| `confidence` | enum: `low` \| `medium` \| `high` (optional) | Shown as a pill (mainly on hypothesis/decision) |
| `tags` | string[] (optional) | Free-form labels |

**Server-stamped on receipt** (not model-supplied, to keep them trustworthy):

| Field | Source |
|---|---|
| `id` | Server-generated unique id |
| `timestamp` | Server wall-clock at receipt |
| `elapsedMs` | ms since the current run started |
| `role` | `agent` now; subagent name in Phase 5 |

**Non-blocking contract:** the tool returns immediately with a small ack (e.g.
`{ ok: true, id }` → surfaced to the model as `logged <id>`). It must never
block on UI, and must not throw on a persistence hiccup in a way that aborts the
run (log + return a soft error to the model instead).

**Prompt guidelines** (tool `promptGuidelines` + a nudge in the seeded
`AGENTS.md`): encourage Kady to log at natural milestones — when forming a
hypothesis, before/after running an analysis, and whenever a result changes its
plan. Encourage attaching `artifacts` whenever an entry corresponds to a figure,
table, or script it just wrote.

## Backend

**New file: `server/src/agent/notebook.ts`**
- Defines the custom tool (typebox schema above).
- Registered in `server/src/agent/session-registry.ts` alongside `interview`
  and `modal` (in-process → **lead-agent-only** until Phase 5; subagent child
  `pi` processes do not see it).
- On call: validate → stamp → append to the notebook JSONL → return ack.

**Persistence**
- Append one JSON row per entry to
  `projects/<id>/sandbox/.kady/notebook/<sessionId>.jsonl`.
- Mirrors the existing cost-ledger pattern
  (`.kady/runs/<sessionId>/costs.jsonl`). This JSONL is the **durable source of
  truth** for reload and export.

**SSE**
- No new frame type. The entry rides the existing `tool_start` frame
  (tool name `notebook`, args = the entry). `server/src/agent/events.ts`
  already forwards tool args, so the client contract is unchanged.
- The server-stamped fields must be present in the args the frontend receives,
  so stamping happens before/as the tool call is surfaced. If Pi surfaces
  `tool_start` from the raw model args (before the tool body runs), the stamped
  fields won't be in that frame; in that case the frontend treats the live
  frame as provisional and reconciles with the authoritative stamped entry from
  the JSONL (via the `GET` endpoint / a lightweight post-run refresh). The
  implementation plan must confirm which of these two paths Pi actually
  provides and pick the simpler one. (Acceptance: the rendered entry always
  ends up with a stable server `id`, `timestamp`, and `elapsedMs`.)

**Endpoints (new, in `server/src/api/` — likely alongside sessions or a small
`notebook.ts` route module)**
- `GET /sessions/:id/notebook` → `{ entries: Entry[] }` (for reload / opening a
  session that already ran).
- `GET /sessions/:id/notebook/export?format=md|pdf` → the exported lab record
  (see Export).

All routes are project-scoped via the existing `X-Project-Id` /
`AsyncLocalStorage` mechanism (`server/src/scope.ts`).

## Frontend experience (the wow)

**Placement**
- An **always-present "Notebook" tab** pinned in the center-panel tab bar for
  the active chat session, with a subtle **live pulse** indicator while entries
  are streaming. It sits next to the file-preview tabs but is not a file — it is
  a persistent view tied to the session.

**Components**
- `web/src/components/notebook-view.tsx` — the timeline container, header
  actions, empty state, data merge.
- `web/src/components/notebook-entry-card.tsx` — a single entry card.

**Visual language**
- Reads as a **vertical timeline** with a connecting thread down the left edge —
  a notebook forming over time, not a chat log.
- Cards are **color-coded by type** with an icon and a colored left spine:
  - Hypothesis — amber / lightbulb
  - Method — blue / beaker
  - Observation — green / chart
  - Decision — purple / signpost
  - Note — gray
- Card contents: bold title, Markdown `body`, a **foldable code block** (from
  `code`), a **confidence pill**, `timestamp` + `elapsedMs`, and **artifact
  chips**.

**Self-writing effect (the headline animation)**
- Each new entry **materializes**: the card fades/slides in, the title "types"
  in, a soft highlight pulse plays, and the view smooth-scrolls to it.
- Tasteful and restrained; fully disabled under
  `prefers-reduced-motion` (entries just appear).

**Cross-links (what makes it feel wired to reality)**
- **Artifact chips** open that file through the existing file-preview registry
  (`web/src/lib/viewers/registry.ts` / `FileViewer`): clicking an Observation's
  figure chip opens the figure in a preview tab; clicking a Method's script chip
  opens the code. This is the difference between a narrated story and a notebook
  genuinely tied to the work.
- Code folds expand inline; long code offers "open as file" when it maps to a
  saved path.

**Data source**
- Live: `useAgent` SSE stream, filtering `tool_start` frames where
  `tool === "notebook"`, appended to entry state.
- On load / session switch: `GET /sessions/:id/notebook`.
- The two are **merged and deduped by `id`** (live frames may be provisional
  and get reconciled by the authoritative stamped entry).

**Header actions**
- **Export** (Markdown / PDF).
- **Jump to latest** control.

## Durability & export

- `notebook.jsonl` is the source of truth; the view reconstructs from it on
  reload.
- **Markdown export** renders entries into a structured, timestamped lab record:
  a header (project, session, date range), then entries in order with type
  headings, Markdown bodies, **embedded figures** (via sandbox paths), fenced
  code blocks, and confidence/tags. This is a genuine deliverable a scientist
  can keep or attach to a paper's supplement.
- **PDF export** renders that Markdown through the app's **existing report /
  LaTeX compile path** (`server/src/api/sandbox.ts` already has an async
  latexmk pipeline) or a lightweight Markdown→HTML→print fallback — whichever is
  simpler to reuse. MD lands first; PDF is the fast-follow within the same phase.

## Subagents (Phase 5)

To show a whole research team's parallel work as threaded sub-entries:
- Promote the notebook tool from an in-process custom tool to a **Pi package**
  (the way `pi-web-access` is packaged), so child `pi` processes get it too and
  write to the **same** notebook store keyed by `role`.
- This requires the child-process package + trust wiring that is a known gotcha
  in this repo (a sandbox `settings.json` package entry + `trust.json`) — see
  the project memory note on child-process package wiring.
- Entries then render in **per-agent lanes** (the lead agent plus each active
  subagent), so the notebook visibly becomes a team lab book.
- Deliberately last, because it depends on Phases 1–4 and adds the most
  integration risk.

## Error handling & edge cases

- **Malformed entry:** typebox rejects → tool returns an error to the model →
  nothing renders. The run continues.
- **Persistence hiccup:** log server-side, return a soft error to the model;
  never abort the run over a notebook write.
- **Missing artifact path:** the chip still renders; clicking surfaces the
  preview panel's normal "not found" state.
- **Long runs (many entries):** the timeline is virtualized / windowed so it
  stays smooth.
- **Reload mid-run:** `GET` snapshot + live stream are merged and deduped by
  `id`; no duplicate cards, no lost entries.
- **Empty state:** a tasteful placeholder — "Kady's notebook — entries appear
  here as it works."
- **Non-cooperating agent:** if Kady never calls the tool, the notebook is
  simply empty for that run (acceptable for v1; the client-side fallback from
  the "hybrid" option was explicitly not chosen).
- **`prefers-reduced-motion`:** all self-writing animation disabled.

## Testing

**Backend (vitest, `server/test/`, `KADY_PROJECTS_ROOT` → temp dir):**
- Tool schema validation (accepts valid entries, rejects malformed).
- Server stamping (id/timestamp/elapsedMs/role present and stable).
- JSONL append (one row per entry; survives reload).
- `GET /sessions/:id/notebook` returns entries in order.
- Markdown export renders expected structure (headings, embedded figures, code).

**Frontend (vitest, `web/`):**
- Renders entries from `tool_start` frames.
- Correct card visual per `type`.
- Artifact-chip click opens the target file via the viewer registry.
- Reduced-motion path renders without animation.
- Reload merge/dedupe by `id` (no duplicates, no drops).

**Manual / e2e agent runs:** only with **Opus 4.8 or GPT-5.5** (per testing
preference; legacy models are out of scope).

**Baseline note:** two pre-existing web test failures (`projects.test.ts`,
`pdf-annotations.test.ts`, jsdom localStorage) exist on a clean checkout — do
not treat them as regressions.

## Phasing

Each phase is independently shippable; Phases 1–2 constitute a usable product.

1. **Tool + persistence + prompt.** `notebook.ts` tool, typebox schema, JSONL
   persistence, prompt guidelines. SSE reuses `tool_start`. Verify entries land
   in `notebook.jsonl` during a real run.
2. **Live view (the visible wow).** Center-panel "Notebook" tab, self-writing
   card timeline, card types, `GET`-for-reload with dedupe.
3. **Cross-links.** Artifact chips open files via the viewer registry; code
   folds; "open as file."
4. **Export.** Markdown export, then PDF via the existing compile path.
5. **Subagent lanes.** Promote to a Pi package for child processes; per-agent
   lanes.

## Out of scope (v1)

- Client-side structuring / narrator-model fallback (explicitly not chosen).
- "Notebook is the report" fusion (brainstorming option C — deferred).
- Editing entries by hand (the notebook is Kady's record; human annotation
  could be a later fast-follow).
- Cross-session / project-level notebook aggregation.
