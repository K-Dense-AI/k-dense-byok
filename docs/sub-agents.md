# Sub-agents: Kady's team of specialists

When you give Kady a big task, it doesn't have to do everything itself. It can hand parts of the work to **sub-agents** - independent helpers that run in the background, do one focused job, and report back. Think of Kady as the lead scientist and sub-agents as the lab members it delegates to.

You don't need to do anything to make this happen. Kady decides on its own when delegating makes sense - for example, reviewing code while continuing the analysis, checking every citation in a manuscript, or running three independent analyses at the same time.

## The specialist roster

Every project comes with **21 scientific specialists** pre-installed. Each one is an expert persona with its own instructions and quality standards:

| Area | Specialists |
|------|-------------|
| **Code & computation** | `code-reviewer`, `statistical-reviewer`, `math-checker`, `ml-auditor`, `data-validator`, `reproducibility-auditor`, `pipeline-engineer`, `data-visualizer`, `simulation-reviewer` |
| **Literature & fact-checking** | `literature-researcher`, `citation-checker`, `fact-checker`, `methodology-reviewer`, `peer-reviewer` |
| **Study design & ideas** | `hypothesis-generator`, `experiment-designer`, `protocol-writer`, `results-interpreter` |
| **Writing** | `manuscript-editor`, `abstract-writer`, `ethics-reviewer` |

A few examples of what they do:

- **`citation-checker`** verifies that every reference in a document actually exists *and* actually supports the claim it's attached to. Anything it can't verify is flagged as "unverifiable" - never quietly passed.
- **`statistical-reviewer`** audits an analysis for the right test, violated assumptions, sample size, and p-hacking patterns - and re-runs the numbers itself when the data is available.
- **`peer-reviewer`** writes a full, journal-style referee report on a manuscript: major concerns, minor concerns, questions for the authors, and a recommendation.
- **`reproducibility-auditor`** checks whether someone else could re-run your analysis from scratch - and actually tries to.

There are also 8 general-purpose agents that ship with the underlying delegation engine ([pi-subagents](https://github.com/nicobailon/pi-subagents)): `reviewer`, `scout`, `planner`, `worker`, `researcher`, `oracle`, `delegate`, and `context-builder`.

## Asking for a specialist directly

You can simply name one in your message:

> "Use the **statistical-reviewer** to check the analysis in `results.ipynb`."

> "Have the **citation-checker** go through `manuscript.md`."

> "Run **peer-reviewer** and **methodology-reviewer** on my draft in parallel and combine their feedback."

Sub-agents can run one at a time, several in parallel, or chained (one's output feeding the next) - Kady handles the orchestration.

## Viewing and customizing sub-agents

Open **Settings (gear icon) → Sub-agents**. From there you can:

- **See every agent** available in the current project, with its description.
- **Edit an agent** (pencil icon) - change its instructions, give it a different model, restrict its tools, or adjust its thinking depth.
- **Add your own agent** - click *Add agent*, give it a name like `assay-qc-checker`, write its instructions in plain language, and save. It's immediately available for delegation in new chats.
- **Delete agents** you don't need. Deletions stick - they won't silently come back.
- **Restore defaults** - brings back the 21 scientific specialists in their original form (your own custom agents are untouched).
- **Customize a built-in** - the 8 engine agents are read-only, but clicking *Customize* copies one into your project where your version takes priority.

### What the settings mean

| Field | What it does |
|-------|--------------|
| **Name** | How Kady refers to the agent (lowercase, hyphens allowed, e.g. `code-reviewer`) |
| **Description** | One line telling Kady when this specialist is the right pick |
| **Model** *(optional)* | Make this agent use a specific model - e.g. a cheaper model for routine checks, a stronger one for hard reviews. Leave empty to use sensible defaults |
| **Thinking level** | How much the agent "thinks before speaking" - higher levels reason more deeply but cost more |
| **Tools** *(optional)* | Limit what the agent can do - e.g. `read, grep, find, ls` makes an agent that can inspect files but never modify them. Empty = full toolset |
| **Inherit project context** | Whether the agent sees your project's `AGENTS.md` instructions |
| **Inherit skills** | Whether the agent can use the project's scientific skills |
| **Replace base system prompt** | Off (recommended): your instructions are *added* to the standard agent behavior. On: your instructions completely replace it |
| **System prompt** | The agent's full instructions - who it is, what standards it applies, and how it should report results |

## Where agents live

Each agent is a plain markdown file in your project at `sandbox/.pi/agents/<name>.md`. The Settings panel is just a friendly editor for these files - you can also view and edit them directly in the file browser. Edits apply to new chat tabs.

## Cost and budgets

Sub-agent work uses your API key like everything else. Their spend is recorded in the same project cost ledger you see in the header, and the project's **spend cap applies to them too** - once a project hits its limit, Kady is blocked from starting new sub-agents.
