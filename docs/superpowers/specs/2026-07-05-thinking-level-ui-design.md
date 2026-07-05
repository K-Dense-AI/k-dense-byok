# Thinking-level control in the chat UI — design

**Date:** 2026-07-05
**Status:** Approved

## Problem

Pi supports per-session reasoning ("thinking") levels — `off | minimal | low |
medium | high | xhigh` (`ThinkingLevel` in `@earendil-works/pi-agent-core`) —
and the backend run endpoint already accepts one: `POST /sessions/:id/run`
takes `thinkingLevel` in the body and calls `session.setThinkingLevel()`
(`server/src/api/sessions.ts:324`). Pi clamps the level to what the model
supports; our synthesized OpenRouter models carry `reasoning: true`, Ollama
models `reasoning: false` (`server/src/agent/models.ts`).

Nothing in the web UI exposes this: no run ever sends `thinkingLevel`, so
every chat runs at Pi's session default. Users cannot raise reasoning effort
for hard research tasks or turn it off for cheap ones.

## Decisions (user-approved)

1. **Placement:** a compact chip + popover in the composer footer between the
   Model and Compute selectors, following the `ComputeSelector` pattern
   exactly.
2. **Levels:** all six Pi levels (Off, Minimal, Low, Medium, High, XHigh).
   Pi clamps for models that support fewer; no per-model level filtering in
   the UI.
3. **Default:** `high` for every new chat tab.
4. **Persistence:** per-tab ephemeral `useState`, matching model and compute
   selection (no localStorage).

## Frontend changes

### New component: `web/src/components/thinking-selector.tsx`

Mirrors `compute-selector.tsx` structurally:

- Exports `type ThinkingLevel = "off" | "minimal" | "low" | "medium" |
  "high" | "xhigh"` and a `THINKING_LEVELS` catalogue (id, label, one-line
  description) rendered as popover rows with the check-circle selection
  indicator.
- Chip: brain icon + current level label (e.g. `High`), `ChevronDownIcon`,
  same border/hover/open styling as the compute chip.
- Props: `{ selected: ThinkingLevel; onChange: (level: ThinkingLevel) =>
  void; disabled?: boolean; disabledReason?: string }`.
- When `disabled`, the chip renders muted with a tooltip
  ("This model doesn't support adjustable thinking") and the popover does
  not open.

### Wiring in `web/src/components/chat-tab.tsx`

- New per-tab state `const [thinkingLevel, setThinkingLevel] =
  useState<ThinkingLevel>("high")` next to `selectedComputeTarget`.
- `<ThinkingSelector>` rendered in `PromptInputFooter` between
  `<ModelSelector>` and `<ComputeSelector>`.
- **Model gating:** the selector is disabled when the selected model id
  starts with `ollama/` (Pi model built with `reasoning: false` — the level
  would be clamped to off) or `fusion/` (the Fusion bridge rewrites the wire
  body; the level is meaningless). While disabled, runs send **no**
  `thinkingLevel`.
- Threaded everywhere `computeTarget` goes:
  - `handleSend`'s `sendNow` passes the current level.
  - `enqueue` captures the level in the queue item (like `model` /
    `computeTarget`); the auto-send effect passes it when draining.
  - The other `send()` call sites (suggestion prompt at ~line 1109, retry at
    ~line 1128) pass the current selection.

### `send()` in `web/src/lib/use-agent.ts`

- New `thinkingLevel?: string` parameter after `computeTarget`.
- Included in the run POST body whenever provided — **including `"off"`**:
  Pi sessions remember the level across runs, so an explicit off is what
  resets a previously raised level. (Unlike `computeTarget`, there is no
  sentinel value to strip.)

## Backend change

`server/src/api/sessions.ts` currently blind-casts
`body.thinkingLevel as ThinkingLevel`. Replace with a validation against the
six allowed values; ignore invalid values (log a warning, keep the session's
current level) rather than 400 — consistent with how a failed `setModel` is
handled in the same route.

## Testing

- `web/src/components/thinking-selector.test.tsx` (new): renders all six
  levels, fires `onChange` with the picked level, disabled state blocks the
  popover and shows the reason.
- `web/src/lib/use-agent.test.ts` (new; `use-agent-events.test.ts` covers
  only event handling): `send()` includes `thinkingLevel` in the run body
  when passed, omits it when absent.
- Server: no test currently covers the `/run` route (only
  `session-export.test.ts` exists); the validation guard is a pure function —
  extract it as `parseThinkingLevel()` and unit-test that instead of standing
  up the route.

## Out of scope

- Querying `getAvailableThinkingLevels()` per model (needs a live session;
  static six + Pi clamping is sufficient).
- Persisting the level across reloads.
- Exposing thinking level to subagent child processes or `latex-assist`.
