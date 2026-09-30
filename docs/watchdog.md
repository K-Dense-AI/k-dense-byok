# Watchdog

The watchdog is an optional second model that looks at what Kady (or a
background specialist) just did and pushes findings back into the chat. It is
provided by the pi-subagents extension Kady embeds; Kady adds scientific
standing instructions and a settings card.

## What it catches

After each turn that changed files (and, optionally, every N tool calls
mid-turn) the watchdog reads the diff, the current request and the project's
`sandbox/.pi/WATCHDOG.md`, and raises a finding when it sees, for example:

- raw data under `user_data/` touched;
- rows or samples dropped without the count being reported;
- thresholds, seeds or model choices changed without a notebook entry;
- claims that tests, QC or reproductions ran when the transcript shows no such
  command;
- an analysis drifting from the frozen plan without a recorded deviation;
- figures inconsistent with tables, truncated axes, overclaiming captions.

A finding appears as a **Watchdog warning** card in the chat with severity,
evidence and a recommended action; the agent gets one continuation to address
it. When the same warning repeats several turns in a row (the stalemate setting
below) the card is marked as a stalemate and the turn ends so you can step in. A clean review shows nothing.

## Turning it on

Settings → **Specialists** → **Watchdog**. Off by default. Options: the model
to review with (picked from the model picker; empty inherits the chat's
model), its thinking level, mid-turn cadence, whether to report concerns or
only blockers, how many times the same warning may repeat in a row before the
turn stops as a stalemate (1–20), whether to review background specialists'
own turns too, and whether to read `WATCHDOG.md`. Number fields save when you
press Enter or leave the field. Changes apply to new chat tabs.

Edit `sandbox/.pi/WATCHDOG.md` (visible in the file panel) to change what the
reviewer looks for in this project; it is seeded once and never overwritten.

## Cost

Kady records watchdog review and permission-review usage in the project ledger,
including clean reviews and provider-reported usage on failed or aborted reviews.
Paid requests are checked against the project spend cap before the provider is
called. Subscription and local models retain their normal billing treatment.
Already-admitted requests can still cross the cap; this is not a provider invoice
limit. Each reviewed turn adds at least one model call.

## Limits

The watchdog reads diffs and the transcript; it does not execute code or
verify results itself, and it can be wrong in both directions. Treat findings
as a prompt to check, not a verdict.

Reviews run at turn boundaries (after Kady's reply) unless a tool cadence is
set, so a finding can appear a few seconds after the reply. A review that
fails — the configured model is unavailable, credentials are missing, the
provider errors — is silent: pi-subagents records the failure internally and
shows nothing in the chat. If findings never appear, check that the watchdog
model is one the picker lists and that its provider is connected, and try a
run that clearly matches WATCHDOG.md (an unexplained row exclusion, a claim
that tests passed without running them). `/subagents-watchdog status` in the
composer prints pi-subagents' own view: runtime state, model, review trigger
and any last error.

Git-based review is scoped to a checkout rooted at the session's working
directory. A sandbox inside the app's ignored `projects/` directory does not
inherit the app checkout's status or diff. Without its own Git root, successful
`write`/`edit` tool events trigger review of the transcript and files; a Git diff
is unavailable. Changes made only through opaque shell commands are not reliably
detected in that mode, so use a mid-turn tool cadence when that coverage matters.
