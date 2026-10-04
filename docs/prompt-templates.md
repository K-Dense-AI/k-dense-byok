# Prompt templates

Type `/` at the start of the composer to select a reusable prompt or a
user-invoked skill:

```text
/qc user_data/expression.csv
/stats-check results/de_table.csv
/skill:lab-protocol PCR plate 3
```

The first line expands; additional lines and file references follow the expanded
text. The transcript shows an expandable **Prompt** or **Skill** chip.
Templates are read fresh from disk when sent.

## Shipped templates

| Command | Purpose |
|---|---|
| `/qc <file>` | Dataset QC report in `derived/`. |
| `/stats-check <file-or-result>` | Review statistical design and analysis. |
| `/figure-audit <figure>` | Check against source data/code. |
| `/methods-review` | Review methods for the current deliverable or requested project scope. |
| `/replicate <script>` | Re-run using copied inputs and compare outputs. |
| `/prove-verify <question> [rounds N] [investigators N] [budget $N]` | Prove–verify rounds on an open question; see [Specialists → Verification](sub-agents.md#verification). |

Customized files and deletions survive seeding; a template added in a later
release appears once in existing projects. **Settings → Prompt templates →
Restore defaults** replaces these six templates, including local edits; other
templates remain. A same-data rerun is not independent scientific replication.

## Write a template

Choose **New template** in Settings. Files support optional frontmatter:

```markdown
---
description: Literature scan for a topic
argument-hint: <topic> [years]
---
Search the literature on $1 from the last ${2:-5} years.
```

Use `$1`, `$2`, etc. for positions, `$@` / `$ARGUMENTS` for all arguments,
`${2:-default}` for fallbacks and `${@:2}` for a trailing slice. Templates with
no placeholders receive all arguments appended; otherwise include placeholders
for the arguments you need. Project templates in `sandbox/.pi/prompts/` override same-named
global templates in `~/.kady/pi-agent/prompts/`.

**Settings → Skills → User-invoked only** hides a skill from automatic discovery
and makes it available through `/skill:<name>`. This controls invocation, not
tool permissions or execution authorization.

## Extension commands

Other leading commands are dispatched to Pi extensions. Status commands such
as `/subagents` and `/subagents-watchdog status` return notice cards without a
model turn.

Implementation: [`prompt-expansion.ts`](../server/src/agent/prompt-expansion.ts)
and [`prompts.ts`](../server/src/agent/prompts.ts).
