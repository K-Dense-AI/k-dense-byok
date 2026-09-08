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

## Shipped templates

| Command | Argument | What it does |
|---|---|---|
| `/qc` | `<file>` | Quality-control report for a dataset, written to `derived/`. |
| `/stats-check` | `<file-or-result>` | Audit the statistics behind a result or script. |
| `/figure-audit` | `<figure>` | Check a figure against the data and code that produced it. |
| `/methods-review` | – | Review everything so far for reproducibility. |
| `/replicate` | `<script>` | Re-run a script from a copy of its inputs and compare outputs. |

They are seeded once into `sandbox/.pi/prompts/`; deleting one sticks, and
Settings → Prompt templates → *Restore defaults* brings them back without
touching your own templates.

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
