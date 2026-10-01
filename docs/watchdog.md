# Watchdog

The watchdog is an optional reviewer model for Kady and its specialists.
Enable it in **Settings → Specialists → Watchdog**; it is off by default.

## Configure and inspect

Choose a model (empty inherits the chat model), thinking level, optional mid-turn
tool cadence, severity threshold, repeated-warning limit and whether to review
specialist turns. Changes apply to new chats. Edit `sandbox/.pi/WATCHDOG.md`
for project review instructions; customized/deleted guidance is preserved.

Reviews look for issues such as unreported exclusions, unsupported completion
claims, plan deviations, altered raw data or inconsistent figures. A finding
appears as a **Watchdog warning** with evidence and a proposed action. The agent
gets a continuation to address it; repeated warnings can stop the turn as a
stalemate.

The reviewer sees bounded diffs/transcript context. It does not execute analyses
or independently verify results, and can miss problems or raise false alarms.
No warning is not proof of correctness.

## Cost and troubleshooting

Review and permission-review usage is ledgered, including clean reviews and
provider-reported failed/aborted usage. Paid requests check the cap before the
provider call; admitted calls can still exceed it. Each review adds model usage.

Review failures can be silent in chat. Check the provider/model and run:

```text
/subagents-watchdog status
```

Git review requires a checkout rooted at the session working directory. A
project sandbox does not inherit the app repository's diff. Without its own
Git root, successful `write`/`edit` events trigger transcript/file review, but
shell-only changes may be missed. Use a tool cadence when that coverage matters.
