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
it. When the same warning repeats several turns in a row the card is marked as
a stalemate and the turn ends so you can step in. A clean review shows nothing.

## Turning it on

Settings → **Specialists** → **Watchdog**. Off by default. Options: the model
to review with (empty inherits the chat's model), its thinking level,
mid-turn cadence, whether to report concerns or only blockers, whether to
review background specialists' own turns too, and whether to read
`WATCHDOG.md`. Changes apply to new chat tabs.

Edit `sandbox/.pi/WATCHDOG.md` (visible in the file panel) to change what the
reviewer looks for in this project; it is seeded once and never overwritten.

## Cost — read this

pi-subagents does not report the watchdog model's token usage anywhere, so its
calls are **not ledgered and do not count toward the project spend cap**. Kady
says so in the settings card. Pick a subscription-billed or local model for the
watchdog if that matters to you, and remember every reviewed turn is at least
one extra model call.

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

When `projects/` lives inside a git checkout (the default install layout), the
"changed paths" the watchdog reports come from that checkout's `git status`,
not from the sandbox, because the sandbox is an ignored directory of the same
repository. Sandbox edits still trigger reviews through the observed-edit
path; only the listed paths are misleading.
