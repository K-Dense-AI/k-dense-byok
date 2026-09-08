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

A schedule fire produces no tool call, so it cannot be gated at the moment it
runs. Kady therefore:

- gates `schedule.create` like a launch (model checks, spend cap) and refuses
  `schedule.run` over the cap;
- once a minute, pauses every active schedule of a project that has reached
  its spend limit and marks it **Held: spend limit** in the panel; when the
  limit is raised (or spend drops), those schedules resume automatically.

Resuming a held schedule by hand while the project is still over the cap is
allowed, but a due fire (including a `catchUp: latest` slot) can run once
before the next hold tick pauses it again.

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
