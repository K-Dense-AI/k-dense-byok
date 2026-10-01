# Specialists

Kady can delegate focused assignments to independent Pi agents in the same
project sandbox. Ask for a named specialist, or let Kady select one:

> Use the statistical-reviewer to check `results.ipynb` and report the checks performed.

## Available roles

The scientific roster covers code/computation, literature/fact checking, study
design and writing. Examples include `statistical-reviewer`, `citation-checker`,
`peer-reviewer`, `data-validator` and `reproducibility-auditor`. **Settings →
Specialists** shows the installed roster and enabled state; the default personas
live in [`subagents.ts`](../server/src/agent/subagents.ts).

The delegation package also supplies general-purpose agents and external-CLI
agents for Claude Code, Codex and Cursor. **External-CLI agents are disabled by
default** because their usage bypasses Kady's runtime, ledger and spend cap.

Native specialists can use files/shell, web, notebook, PDF annotations, Modal and
[MCP tools](mcp-servers.md), subject to the parent's tool ceiling and their own
allowlist. They do not receive the lead's interview form.

## Assignments and supervision

A brief should name inputs, allowed edits, outputs, completion criteria and
limits. Parallel workers share files, so give them distinct responsibilities.
Handoffs report completed/partial/blocked status, supporting evidence, checks
performed, artifacts and remaining questions. A completed review can find an
invalid result; completion is not a scientific verdict.

A specialist uses `contact_supervisor` for blocking decisions. Kady resolves the
request from existing instructions or asks you through the interview form.
The child waits up to ten minutes; timeout/dismissal is not approval.

Open **Automation → Specialist fleet**, select a chat and inspect live transcripts,
models, tokens and activity. Controls let you steer, stop or resume work.

## Customize

In **Settings → Specialists**, add/edit a role, enable/disable it or choose
**Default model for specialists**. Definitions live in `sandbox/.pi/agents/`;
disabled project files move to `.pi/agents-disabled/`. Changes apply to new chats.

| Field | Meaning |
|---|---|
| Model | Pin a model; otherwise use the project specialist default or launching chat. A workflow override can take precedence. |
| Thinking | Pin reasoning effort rather than inheriting Pi's current default. |
| Tools | Optional allowlist; empty uses the available inherited toolset. |
| Inherit context/skills | Include project instructions and skills. |
| Replace base system prompt | Replace rather than append to default behavior. |
| Persistent memory | Enable a role-specific, model-written `MEMORY.md` in project or user scope. |

**Customize** copies a built-in into the project. **Restore defaults** replaces
same-named scientific roles and re-enables defaults; retain edits you want to keep.
Other custom agents remain. Deletions stay deleted.

## Memory, review and accounting

Persistent memory is off by default. Its first 200 lines are supplied to later
runs; use the row's **Memory** control to read/edit/clear it. It is model-authored
instruction text, not verified evidence. Project files live under
`.pi/agent-memory/<agent>/`.

The optional [watchdog](watchdog.md) reviews work with another model. Native
specialist and review usage use normal [billing rules](model-selection.md#billing-and-budgets).
Paid requests check committed spend before dispatch; concurrent/in-flight calls
can exceed the cap. Durable receipts recover accounting after backend outages.

Notebook and provenance harvest direct children on completion, not nested
children. See [Automation](automation.md) for schedules and missions.

Maintainers: [`patch-subagents.mjs`](../server/scripts/patch-subagents.mjs)
installs version-checked host hooks; startup/install fail on upstream drift.
Review these alongside dependency upgrades. Runtime policy lives in
[`subagent-control.ts`](../server/src/agent/subagent-control.ts).
