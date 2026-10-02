# Automation

Open the project's **Automation** tab for schedules, missions and the specialist
fleet. These use pi-subagents with Kady's project policy and accounting.

## Schedules

Ask Kady to create a schedule with a task, specialist, interval or one-shot time,
and model. For example: “Every six hours, have the data validator re-check
`user_data/` and log changes in the notebook.” Each fire runs with fresh context;
results and costs are recorded like other specialist work.

The panel shows triggers, next run, outcomes and spend. Expand a schedule for
its script, pinned model, quiet setting and history; each completed fire shows
the specialist's result text (kept by Kady from the completion, bounded).
Controls run now, pause/resume or delete it. Creation stays conversational.

**Run now** fires quietly: the panel shows the result, so the completion does
not start a billed Kady turn on the hidden resident session. It is refused
while the project is over its spend limit, and so is resuming a schedule held
by the limit.

A resident session keeps timers active without an open chat. **The backend must
remain running.** With `catchUp: latest`, the latest missed slot runs on next
boot; overlapping fires are skipped rather than queued.

A pinned schedule model survives restart. Without a pin, work can inherit the
resident session's model, which follows the project's latest chat model. Pin a
model when later chat changes must not affect a schedule.

## Policy and cost

Schedules retain their creation-time tool ceiling and intersect it with the
current host policy. Later additions do not grant old schedules extra tools;
removals take effect. These persisted schedules require Kady's host.

Each paid child model request checks committed spend before dispatch. Active
schedules are also periodically marked **Held: spend limit** and resume after
the limit clears. In-flight calls can still exceed the cap; see
[billing](model-selection.md#billing-and-budgets).

## Missions

Missions persist a delegation's purpose, runs, decisions, artifacts and delivery
receipts in the Pi agent directory. The panel lists status and can close a
mission; the agent can inspect it with `mission.show` to resume work. Goal
missions with token budgets remind the agent until closed or exhausted.

## Specialist fleet

Choose a chat to inspect active specialists, models, tokens, elapsed time,
tool activity and background compute. **Scheduled runs** selects the resident
session, where schedule fires run; the chat list refreshes every 15 seconds.
Open a run/child for its live transcript and steer/stop/resume controls.
Plugin snapshot omissions are shown. Stop asks for confirmation.

An unfinished Modal job keeps its owning session's background-work state active.
Use the [Compute tab](modal-compute.md) for job-specific cancellation and recovery.
