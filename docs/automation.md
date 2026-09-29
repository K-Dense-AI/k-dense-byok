# Automation: schedules and missions

Kady's specialists can run on a timer and remember long-running work across
restarts. Both come from the pi-subagents extension Kady embeds; Kady adds the
server-side host that makes them fire when no chat is open, the spend-cap
hold, the ledger attribution and the **Automation** tab in the project view.

## Schedules

Ask Kady in a chat:

> Every 6 hours, have the data validator re-check `user_data/` and log a
> notebook entry. Only warn me if something changed.

Kady confirms the interval, the specialist and the expected cost, then creates
a durable schedule (`schedule.create` with `every: "6h"`; one-shot schedules
use `at: "+30m"` or a timestamp). Each fire launches the workflow as a
background run with fresh context; completions arrive in the notebook and the
provenance log like any delegation, and the cost is ledgered with the
schedule's id so the panel can show what each schedule has spent.

### How they fire without a tab

pi-subagents arms a schedule's timers inside a live Pi session. Kady keeps one
**resident session** per project that has active schedules (opened at boot and
when a schedule is created or resumed, never evicted, hidden from the chat
list). Completion notices on that session become system runs; their text is in
that session's history and their entries in the project notebook.

Limits: timers live in the server process. If the server is down when a
schedule is due, the run is missed; with `catchUp: latest` (the default) the
most recent missed slot runs at the next boot. Overlapping fires are skipped.

### Spend cap

Kady checks the resolved model immediately before every child model request,
including timer-fired schedules and resumed work. Paid requests cannot start
once the project's committed spend has reached its cap; local and subscription
models use their normal billing rules. In-flight requests can still cross the
limit because model costs are known only after the response.

The server also pauses active schedules once a minute when the cap is reached,
showing **Held: spend limit**, and resumes held schedules after the limit clears.
That timer is a convenience; provider admission enforces the limit even between
ticks or immediately after a manual resume.

### Which model a scheduled run uses

A fire happens inside the project's resident automation session, and a child
inherits that session's model unless its `runs.run(...)` options pin `model:`.
The resident session follows the model most recently used in a chat of the
project (Pi's default model would otherwise apply, which is the most expensive
one in the picker); completion notices that trigger a turn on that session use
the same model. Ask Kady to pin a specific model in the script when a
schedule must not follow later chat-model changes.

## Missions

Multi-step delegations create a **mission**: a durable record of why the work
exists, its runs, decisions, artifacts and delivery receipts, stored in Kady's
agent directory. Missions survive restarts and compaction; Kady can resume
from `mission.show`. Goal missions with a token budget send a reminder after
each turn until closed or exhausted. The panel lists missions with their
status and lets you close one.

## The Automation tab

Project view → **Automation** (next to Compute): schedules with their trigger,
next run, last outcome and spend; expand one for its workflow script and run
history. Buttons: run now, pause/resume, delete. Missions below. Creation stays
conversational.

## Specialist fleet

The **Automation** tab includes a fleet view. Choose a chat to see active
specialists, models, token counts, elapsed time, tool activity and background
compute. Open a run or child to read its live transcript, send guidance, stop
it, or resume paused/completed work with new instructions. Stop asks for
confirmation. The view is bounded by the plugin's snapshot limits; omitted
entries are called out. Use **Refresh chats** to include newly opened chats.

Modal jobs participate in the plugin's background-work protocol: an unfinished
job owned by a lead or child session keeps its background-work state active.
