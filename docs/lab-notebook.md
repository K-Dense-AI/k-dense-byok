# Lab Notebook

The center-panel **Lab Notebook** contains entries authored through Kady's
`notebook` tool, plus your notes and annotations. It is a research record, not
a complete execution trace; [Provenance](provenance.md) records observed tool work.

## Reading and annotating

**All chats** merges the project's notebooks; **This chat** limits the view to
the active session. Filter by type, tag or text, or switch between timeline and
agent lanes. Pin entries, add comments and write your own notes. Pins, comments
and notes remain chat-scoped.

Lead entries appear live. Specialist entries arrive when the child finishes.
Asynchronous child entries lack a run ID; nested children are not harvested.
Refresh failures remain visible rather than silently presenting an old view as current.

## Entries and evidence

Entries have a type (`hypothesis`, `method`, `observation`, `decision`, `note`),
title and optional body, code, tags, artifacts and result references. Confidence,
limitations, applicability and reconsideration conditions are authored judgments.

- **Evidence links** use `supports`, `challenges`, `inconclusive` or `context`. All active linked observations contribute to the hypothesis status. Counts are not independent replications or probabilities.
- **Outcomes** distinguish signal, null, inconclusive and technical failure. A failure is context, not evidence against a hypothesis.
- **Execution reports** distinguish planned, attempted, completed and unverified work. Completion needs concrete command/output evidence; a label alone remains unverified. Reports do not approve execution or independently prove it occurred.
- **Corrections** append an entry with `supersedes`. Superseded observations stop contributing to active evidence; an amendment must state its own links.
- **Cross-chat references** include the source session so identical entry IDs cannot redirect a link.

Only saved entries contribute evidence. A proposal, frozen plan or planning
preference is not an observation.

## Artifact freshness and saved results

New lead entries capture bounded citation-time file hashes. Later reads/exports
show **Unchanged**, **Changed**, **Missing** or **Unverified**. Changed/missing
citations produce **Needs review** without changing the scientific evidence stance.

Hashes establish byte identity, not scientific validity or retained copies.
Citations without write-time identities, including harvested child citations,
remain unverified. Direct checks cover up to 25 paths per entry, 100 files per
read, 8 MiB/file and 32 MiB total; exhausted checks are explicit. Use provenance
for upstream lineage.

**View saved result** opens a referenced persisted `scientific_result` card.
New lead references pin its content digest when the source can be fully checked.
A changed pinned card is withheld as original evidence; unavailable or unpinned
records are labelled. Files linked inside cards open their **current** bytes.

## Frozen analysis plans and deviations

On a saved hypothesis, open **Analysis plan**:

1. Specify outcomes, eligibility rules, model, multiplicity, QC, stopping rules, datasets and prior data exposure; state unknowns explicitly.
2. Review the exact plan and dataset identities. A preview lasts 15 minutes; unverified datasets need acknowledgement.
3. Approve the local freeze. Changes to data, the source or journal head require a new preview.
4. Revise with a reason and another review. Record deviations against the exact revision/field, including what changed, why and when results were inspected. Corrections append to history.

Freezing neither executes nor enforces the plan. It makes no model/compute call
and is not external preregistration or proof of data-naivety. Plan journals
require filesystem hard-link support and retain up to 256 events per hypothesis;
corrupt or incomplete journals fail visibly.

## Related workflows

| Control | Purpose |
|---|---|
| [Stress-test finding](notebook-robustness.md) | Review and approve 2–16 sensitivity specifications on Modal. |
| [What next?](next-experiments.md) | Generate source-linked proposals and record planning preferences. |
| [Research memory](notebook-memory.md) | Search saved project records and read exact sources. |
| [Evidence package](evidence-packages.md) | Prepare a frozen reviewer ZIP with version checks and explicit gaps. |

## Export and print

The export menu offers Markdown, JSON and a ZIP with referenced artifacts.
**PDF** opens a print view using the browser's print dialog. Exports preserve
plan/deviation records and result identities, but the lightweight ZIP is not an
archive of all prior artifact versions or canonical Pi session logs. Use an
evidence package for version-matched reviewer materials.

## Methods draft

**Methods draft** asks for confirmation before one billed, budget-gated model
call. It uses active methods, observations, decisions and recorded deviations,
with plan history, results and qualifications. A plan alone is insufficient.
Planned/attempted work and missing execution evidence must remain explicit;
proposals and planning preferences are excluded from performed-methods prose.

The draft is saved as `methods_draft_<sessionId>.md` and opens for review. Its
source citations and claims still require checking. Usage appears under
`methods-draft` in project costs.

## Context compaction

Automatic compaction summarizes older conversation when context fills. Kady adds
a bounded state block from notebook/plans/results/provenance and pending work,
then asks the model for a scientific summary. Narrative can omit details; status
snapshots must be rechecked before resuming work. Compaction is billed, and a
Kady summary failure falls back to Pi's default behavior.

Use **Compact now** beside the context gauge while idle. Configure automatic
compaction under **Settings → General → Context compaction**.

## Storage

Entries live in `.kady/notebook/<sessionId>.jsonl`; user annotations are in the
adjacent `.annotations.json` file. Reviewed plans live under `.kady/notebook/plans/`.
Closing a tab does not delete its record. These same-user local files are not
tamper-proof; see [Security](security.md).
