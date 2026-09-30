# Prompt templates

A prompt template is a Markdown file that expands into a full instruction when
you type `/name` in the chat. Kady ships a few scientific ones and you can add
your own, per project or for every project.

## Using one

Type `/` at the start of the composer to open the menu. It lists the templates
and, below them, skills marked *user-invoked only* as `/skill:<name>`. Pick
one, add arguments after it and send:

```
/qc user_data/expression.csv
/stats-check results/de_table.csv
/skill:lab-protocol PCR plate 3
```

Only the first line is the command; anything else in the message (further
lines, attached file references) is appended after the expanded text. In the
transcript the message shows as a compact **Prompt: /qc** (or **Skill: name**)
chip you can expand to see exactly what the model received.

### Extension commands

A leading `/command` that is neither a template nor a skill is handed to Pi,
which dispatches the slash commands its extensions register. pi-subagents
ships several; the useful ones in Kady are read-only status reports that come
back as a notice card instead of a model turn:

```
/subagents-watchdog status
/subagents
```

## Shipped templates

| Command | Argument | What it does |
|---|---|---|
| `/qc` | `<file>` | Quality-control report for a dataset, written to `derived/`. |
| `/stats-check` | `<file-or-result>` | Audit the statistics behind a result or script. |
| `/figure-audit` | `<figure>` | Check a figure against the data and code that produced it. |
| `/methods-review` | – | Review methods for the current deliverable, or the whole project when requested. |
| `/replicate` | `<script>` | Re-run a script from a copy of its inputs and compare outputs. |

They are seeded into `sandbox/.pi/prompts/`. Exact unchanged older shipped
versions upgrade on the next seed pass; customized files and deletions stay
as you left them. Settings → Prompt templates → *Restore defaults* replaces
the five shipped templates with their current versions (including any edits
to those five); other templates are untouched.

QC distinguishes sampled checks from full scans and writes uniquely named
reports. Statistical checks follow the actual study design. Figure audits
separate visual inspection from verified numerical comparisons. Replication
checks inspect output destinations and capture baselines before running in a
fresh directory; a same-data rerun is not independent scientific replication.

The workflow catalog uses the same conditional-method principle: establish
the question and design before applying a recipe, report omitted or substituted
steps, and distinguish planned work from observed results. Its statistical,
ANOVA, meta-analysis, cleaning and time-series templates include specific
design, applicability and leakage checks.

## Writing your own

Settings → **Prompt templates** → *New template*. A template is a `.md` file
with optional frontmatter:

```markdown
---
description: Literature scan for a topic
argument-hint: <topic> [years]
---

Search the literature on $1 from the last ${2:-5} years. Summarize …
```

Arguments: `$1`, `$2`, … positional; `$@` or `$ARGUMENTS` all of them;
`${2:-default}` with a fallback; `${@:2}` from the second onward. A template
without any placeholder still receives its arguments, appended after the body.

Scopes: **This project** (`sandbox/.pi/prompts/`) or **All projects**
(`~/.kady/pi-agent/prompts/`, shared by every project and by a standalone Pi
pointed at the same agent directory). A project template with the same name
wins.

## Skills you invoke yourself

Settings → Skills → toggle **User-invoked only** on a skill to add Pi's
`disable-model-invocation: true` to its frontmatter. The skill then disappears
from the model's skills index (it will never activate on its own) and runs only
when you type `/skill:<name>`. Use it for expensive or destructive protocols
that must not start without you.
