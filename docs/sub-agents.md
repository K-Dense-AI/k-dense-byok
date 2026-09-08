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

The underlying delegation engine ([pi-subagents](https://github.com/nicobailon/pi-subagents)) also ships six general-purpose agents — `reviewer`, `scout`, `worker`, `researcher`, `oracle`, and `delegate` — plus six that shell out to a locally installed and authenticated Claude Code, Codex, or Cursor CLI (`claude-code`, `codex-exec`, `cursor-agent` and their `-writer` variants). The external-CLI agents are **disabled by default** because they run outside Kady's model runtime, cost ledger, and spend cap; the Specialists tab always shows the roster actually installed.

Specialists work in the same project sandbox as Kady with the same file/shell tools, and can search the web, write to the [Lab Notebook](./lab-notebook.md), annotate PDFs, and submit [Modal compute](./modal-compute.md) jobs. They run headless, so they never get the clarifying-questions form, and tools from connected [MCP servers](./mcp-servers.md) are currently available to Kady only.

## Asking for a specialist directly

You can simply name one in your message:

> "Use the **statistical-reviewer** to check the analysis in `results.ipynb`."

> "Have the **citation-checker** go through `manuscript.md`."

> "Run **peer-reviewer** and **methodology-reviewer** on my draft in parallel and combine their feedback."

Sub-agents can run one at a time, several in parallel, or chained (one's output feeding the next) - Kady handles the orchestration.

## Viewing and customizing sub-agents

Open **Settings (gear icon) → Specialists**. From there you can:

- **See every agent** available in the current project, with its description.
- **Enable or disable an agent** with its toggle. Disabling is non-destructive (the file moves to `sandbox/.pi/agents-disabled/`) and applies to new chat tabs.
- **Edit an agent** (pencil icon) - change its instructions, give it a different model, restrict its tools, or adjust its thinking depth.
- **Add your own agent** - click *Add agent*, give it a name like `assay-qc-checker`, write its instructions in plain language, and save. It's immediately available for delegation in new chats.
- **Delete agents** you don't need. Deletions stick - they won't silently come back.
- **Restore defaults** - brings back the 21 scientific specialists in their original form (your own custom agents are untouched).
- **Customize a built-in** - the engine's agents are read-only, but clicking *Customize* copies one into your project where your version takes priority.

### What the settings mean

| Field | What it does |
|-------|--------------|
| **Name** | How Kady refers to the agent (lowercase, hyphens allowed, e.g. `code-reviewer`) |
| **Description** | One line telling Kady when this specialist is the right pick |
| **Model** *(optional)* | Make this agent use a specific model - e.g. a cheaper model for routine checks, a stronger one for hard reviews. Leave empty and the agent inherits the chat's model |
| **Thinking level** | How much the agent "thinks before speaking" - higher levels reason more deeply but cost more |
| **Tools** *(optional)* | Limit what the agent can do - e.g. `read, grep, find, ls` makes an agent that can inspect files but never modify them. Empty = full toolset |
| **Inherit project context** | Whether the agent sees your project's `AGENTS.md` instructions |
| **Inherit skills** | Whether the agent can use the project's scientific skills |
| **Replace base system prompt** | Off (recommended): your instructions are *added* to the standard agent behavior. On: your instructions completely replace it |
| **System prompt** | The agent's full instructions - who it is, what standards it applies, and how it should report results |

## When a specialist needs you

Background specialists cannot show you a form themselves. When one hits a
decision it cannot make (pi-subagents' `contact_supervisor`), the request
arrives in the chat as a **Subagent needs a decision** card and Kady relays the
question with its interview form, then passes your answer back. Answer
promptly: the specialist is blocked while it waits, up to ten minutes. If the
chat tab was closed, the server still adopts the request as a run; reopen the
tab to see and answer it. Progress updates from specialists appear as cards
too and need no answer.

## Watchdog

An optional reviewer model can watch each turn for scientific mistakes and
push findings into the chat. See [watchdog](./watchdog.md).

## Where agents live

Each agent is a plain markdown file in your project at `sandbox/.pi/agents/<name>.md`. The Settings panel is just a friendly editor for these files - you can also view and edit them directly in the file browser. Edits apply to new chat tabs.

## Cost and budgets

Sub-agent work uses your model access like everything else - a specialist inherits the chat's model unless it pins its own. Their spend is recorded in the same project cost ledger you see in the header, and the project's **spend cap applies to them too** - once a project hits its limit, Kady is blocked from starting new sub-agents. The exception is the external-CLI agents above, whose usage is billed by that CLI's own account and never appears in Kady's ledger.
