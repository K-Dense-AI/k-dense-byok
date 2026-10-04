# Specialists

Kady can delegate focused assignments to independent Pi agents in the same
project sandbox. Ask for a named specialist, or let Kady select one:

> Use the statistical-reviewer to check `results.ipynb` and report the checks performed.

## Available roles

The scientific roster covers code/computation, literature/fact checking, study
design and writing. Examples include `statistical-reviewer`, `citation-checker`,
`peer-reviewer`, `data-validator`, `reproducibility-auditor`, `investigator` and
`comparative-reviewer`. Specialists added in a later release appear once in
existing projects; deleting one keeps it deleted. **Settings →
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

To run several specialists, or one in stages, Kady writes a short workflow
script in its reply and launches it. The script appears in chat as a collapsed
**Workflow script** block naming the specialists it starts; expand it to read
the plan. Kady checks the specialists and models it names against the spend cap
before anything runs. Kady can hand the chat back while specialists keep
working; when they finish, it picks their results up in a new turn of the same
chat, which an open tab shows automatically.

A specialist uses `contact_supervisor` for blocking decisions. Kady resolves the
request from existing instructions or asks you through the interview form.
The child waits up to ten minutes; timeout/dismissal is not approval.

Open **Automation → Specialist fleet**, select a chat and inspect live transcripts,
models, tokens and activity. Controls let you steer, stop or resume work.

## Verification

Reviewers check work in two modes. An ordinary review reports evidence-backed
findings. A **verification gate** decides whether a result is accepted: Kady
opens the brief with "Verification gate:", and the reviewer treats every step as
unestablished and every citation as wrong until it has checked them itself, then
ends with `Verdict: accept`, `repair` or `reject`, naming the first failing step
and listing the steps it did confirm. Kady accepts a gated result only when its
reviews pass and does not overrule an objection on plausibility.

`comparative-reviewer` reads several independent attempts at the same question
side by side. It catches what a per-attempt review misses: assumptions or inputs
every attempt shares without justification, contradictions between attempts, and
agreement that only reflects a shared flawed input.

`/prove-verify <question>` runs rounds of this (after Cogentic, a multi-agent
harness for proof discovery, [arXiv:2609.40324](https://arxiv.org/abs/2609.40324)):

1. Kady states the target precisely and creates
   `derived/prove-verify/<slug>-<time>/ledger.md`, with **Verified** results,
   **Excluded** directions (each with its counterexample or objection) and
   **Attempts**.
2. Each round, `investigator` specialists work different directions in parallel:
   a claim to establish or refute, a counterexample search, or a repair of a
   promising draft. Kady assigns what to attempt, never how, and writes each
   brief separately, passing earlier attempts and their objections by path.
3. Each draft goes through a gate with the reviewer that fits the claim
   (`math-checker`, `statistical-reviewer`, `code-reviewer`, …), and one
   `comparative-reviewer` gates the round as a whole. A draft is accepted only
   when both pass.
4. Kady updates the ledger, re-verifies steps that were confirmed inside a
   rejected draft before reusing them, adds warnings about recurring mistakes to
   the next briefs, and sends `literature-researcher` after an obstacle that
   keeps blocking progress.
5. When a result passes, or the limits are reached, Kady writes `report.md`, has
   a fresh gate check it against the accepted draft, and logs the result, the
   excluded directions and what remains open in the lab notebook.

Kady orchestrates but does not judge: it does not do the derivations or decide
which direction is promising. Defaults are 3 rounds of at most 3 investigators;
add `rounds 5`, `investigators 2` or `budget $10` to the command to change them.
The dollar limit is checked between rounds against all project spend since the
loop started, so it errs high; the project spend limit remains the hard stop. A
round with three investigators and four gates is seven specialist runs, so this
costs several times an ordinary answer.

### Verifier model

**Settings → Defaults → Verifier model** runs every verifier on a model of your
choice, so work is checked by a different model than the one that produced it.
Verifiers are the reviewer roles (`code-reviewer`, `statistical-reviewer`,
`math-checker`, `ml-auditor`, `data-validator`, `reproducibility-auditor`,
`simulation-reviewer`, `citation-checker`, `fact-checker`,
`methodology-reviewer`, `peer-reviewer`, `comparative-reviewer`,
`ethics-reviewer`) and the built-in `reviewer` and `evidence-auditor`;
**Settings → Specialists** marks them. Kady writes the choice into each project
as `subagents.agentOverrides.<name>.model` in `sandbox/.pi/settings.json`, which
reaches structured delegations, workflow scripts, schedules and background runs
alike, and records the entries it owns in `.kady/verifier-models.json`.

- A verifier with its own **Model** keeps it; an override you edit by hand in
  `settings.json` becomes yours and is left alone.
- It outranks **Default model for specialists**, which still applies to the
  other roles. A model Kady passes for a whole workflow would outrank it, so
  Kady is told not to pass one for verifiers.
- If the model's provider is disconnected, verifiers keep their usual model
  until it is reconnected; the check runs before every delegation.
- Changes apply to the next delegation, including in open chats. Verifier usage
  is billed and capped like any other specialist run.

## Customize

In **Settings → Specialists**, add/edit a role, enable/disable it or choose
**Default model for specialists**. Definitions live in `sandbox/.pi/agents/`;
disabled project files move to `.pi/agents-disabled/`. Changes apply to new chats.

| Field | Meaning |
|---|---|
| Model | Pin a model; otherwise use the project specialist default or launching chat. A workflow override can take precedence. |
| Thinking | Pin reasoning effort rather than inheriting Pi's current default. |
| Tools | Optional allowlist; empty uses the available inherited toolset. `mcp:<server>` or `mcp:<server>/<tool>` grants a [connector](mcp-servers.md)'s tools. |
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
