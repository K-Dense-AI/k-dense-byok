# Mid-run steering (Pi steer/followUp) — design

**Date:** 2026-07-05
**Status:** Approved

## Problem

While the agent is running, a scientist watching intermediate output cannot
course-correct ("actually, exclude sample 7") without aborting the run and
losing in-flight work. The composer already stays live during streaming, but
Enter only pushes into a client-side queue whose entries each start a **new
run after the current one finishes** — the running agent never sees them.

Pi natively supports this: `session.steer(text)` queues a message delivered
after the current assistant turn's tool calls, before the next LLM call;
`session.clearQueue()` returns undelivered messages; a `queue_update` event
(already mapped in `server/src/agent/events.ts`) reports pending messages; and
delivery of a steer emits `message_start` with `role: "user"` and the full
message content. Steered user messages are persisted to the session JSONL, so
`toHistory` replays them correctly on reload with no extra work.

## Decisions (user-approved)

1. **Enter while streaming = steer.** Alt+Enter keeps today's behavior
   (queue a new run, with per-message model/compute selection). Mirrors Pi's
   TUI (Enter=steer, Alt+Enter=follow-up).
2. **Stop restores undelivered steers to the composer** (Pi TUI behavior via
   `clearQueue()`); typed text is never silently lost.
3. **Approach A:** a dedicated `POST /sessions/:id/steer` side channel. The
   existing `/run` SSE stream remains the single event channel. `/run`'s
   contract and the `activeRuns` guard are untouched.

Pi's `followUp()` is deliberately **not** used: the existing client-side
"run after" queue already covers deferred work and additionally supports
per-message model/compute switching, which Pi follow-ups (which run inside
the live `prompt()` loop on the session's current model) cannot.

## Server changes

### `POST /sessions/:id/steer` (`server/src/api/sessions.ts`)

Body: `{ message: string }`.

| Condition | Response |
|---|---|
| Unknown session | 404 `{ detail }` |
| Empty/missing message | 400 `{ detail }` |
| `!session.isStreaming` (steer raced run end) | 409 `{ detail, reason: "not_streaming" }` |
| `isBudgetExceeded(projectId)` | 403 `{ detail, reason: "budget" }` |
| OK | `await session.steer(message)` → `{ ok: true, pending: string[] }` |

The budget check exists because a steer extends a live run's spend past the
point the run-start check gated. No `activeRuns` interaction: steering never
creates a second run or SSE stream.

### Abort returns the cleared queue

`POST /sessions/:id/abort` calls `session.clearQueue()` **before**
`session.abort()` (so a pending steer cannot be delivered into the dying
loop) and returns `{ ok: true, restored: string[] }` — the concatenation of
cleared steering + followUp texts (followUp always empty in practice).

### `events.ts`: user-message content on `message_start`

When `ev.message.role === "user"`, include the message text as `content`
(flattened from string-or-content-array via the existing text-extraction
helper). This marks the exact delivery point of a steer in the stream. The
`queue_update` mapping already exists and is unchanged.

### Cost

No changes. The run's `turn_end` tally and before/after stats snapshot
already cover steered turns because they execute inside the same
`session.prompt()` call; the terminal `cost` frame reports the whole run.

## Frontend changes

### `use-agent.ts`: multi-message runs

Extract the per-frame logic into a pure, unit-testable transcript reducer
(working name `applyFrameToTranscript(messages, frame)`), replacing the
single-assistant-message assumption:

- `message_start` with `role: "user"` **and** `content`: finalize the
  current assistant bubble, append a user message with that content, open a
  new assistant bubble that subsequent frames apply to.
- The **first** user `message_start` of each run's stream is skipped — it is
  always the prompt itself, already rendered optimistically by `send()`.
- All other frames behave as today (`applyFrameToMessage` semantics). The
  terminal `cost` frame lands on the **last** assistant bubble; the whole
  run's cost attributes to the final message (accepted trade-off).
- `queue_update` frames maintain new hook state `pendingSteers: string[]`
  (authoritative; a successful `steer()` also adds optimistically). Cleared
  when the run ends or aborts.

Hook API additions:

- `steer(text): Promise<"ok" | "not_streaming" | "error">` — POSTs to
  `/steer`; distinguishes the 409 fallback from real failures.
- `stop()` now resolves with `restored: string[]` parsed from the abort
  response (missing field → `[]`).

### `chat-tab.tsx`: composer routing and chips

- `handleSubmit` while streaming: **steer** by default. On
  `"not_streaming"`: if the run-after queue is non-empty, append to it
  (preserves order); otherwise fall back to a normal `send()`.
- Steered text goes through the same `ChatInput` augmentation as a normal
  send (attached-file refs, database/skills context appended, chips
  cleared) — steering "look at @plot.png" must work.
- Pending steers have no client-side cap (Pi imposes none and delivery is
  fast); the `MAX_QUEUE` cap continues to apply only to the run-after queue.
- **Alt+Enter** while streaming routes to the existing queue path
  (intercepted in the textarea `onKeyDown` before the library submit).
  The `QueuedMessage` shape and auto-send effect are unchanged.
- The queue popover shows two groups: **"Steering — delivers mid-run"**
  chips (from `pendingSteers`, no per-item ✕ in v1 — steers deliver within
  seconds and Stop restores them) above the existing "Run after" items
  (which keep per-item remove).
- Placeholder while streaming: `"Steer the run… (⌥↵ to run after)"`.
  Submit button stays **Stop** while streaming (Enter steers, button
  stops); tooltips updated to explain the split.
- **Stop**: restored text from `stop()` is appended to the composer via the
  existing `appendToComposer` helper (multiple messages joined with
  newlines).
- Steered messages render as ordinary user bubbles mid-run; no badge.

## Error handling

- Steer network failure or 403 budget: restore the typed text to the
  composer and show a small inline error. Never silently dropped.
- 409 `not_streaming`: silent fallback (queue or send) as above.
- Abort response without `restored`: treat as empty list.
- Interview forms: no special handling — a steer queued while an interview
  blocks the run is delivered after the interview tool resolves.
- Fusion runs: no special casing; a steer delivered to a tool-less fusion
  turn simply triggers another fusion completion, same as a follow-up
  question would.

## Testing

- **Server (vitest):** steer endpoint guards (404/400/409/403) and
  abort-returns-queue using a stubbed session in the registry;
  `message_start` user-content enrichment as pure `toClientFrame` tests.
- **Frontend (vitest):** `applyFrameToTranscript` — steer splits the
  transcript, first-user-message skip, cost lands on last bubble,
  `queue_update` → `pendingSteers`; submit routing (Enter steer /
  Alt+Enter queue / `not_streaming` fallback ordering).
- **Manual (real run):** steer during a long bash step; two steers
  back-to-back; Stop with a pending steer (composer restore); budget-capped
  steer; reload after a steered run (history interleaving).

## Out of scope

- Pi `followUp()` delivery mode (covered by the client-side queue).
- Per-item removal of pending steering chips (would need
  `clearQueue()` + re-steer; low value since delivery is fast).
- Image attachments on steered messages (`steer(text, images)`) — text only
  in v1.
- Steering for subagent child processes (headless, out of reach by design).
