# Evidence-aware notebook: feature map

The [Living Lab Notebook](./lab-notebook.md) grew from a running log into a
structured research record through six features. All six are implemented; this
page is the one-place map of what each does, where it is documented, and the
design rules they share. It deliberately enhances the existing hypothesis cards
rather than introducing a separate Conclusions view.

| # | Feature | What it gives you | Doc |
|---|---|---|---|
| 1 | **Evidence and freshness** | Typed `supports` / `challenges` / `inconclusive` / `context` links from observations to hypotheses, with all active evidence summarised rather than latest-entry-wins; superseded observations drop out; bounded server-measured citation-time hashes flag artifacts that changed after they were cited | [lab-notebook.md](./lab-notebook.md#threading-hypotheses-evidence-amendments) |
| 2 | **Frozen analysis plans and structured results** | User-reviewed, immutable plan revisions with dataset identities and append-only deviations; `results` links to persisted `scientific_result` cards instead of re-typed measurements | [lab-notebook.md](./lab-notebook.md#frozen-analysis-plans-and-deviations) |
| 3 | **Robustness workflows** | *Stress-test finding*: 2–16 reviewed sensitivity specifications run as one approved, fully reserved Modal batch; every attempt is retained, and the summary is a descriptive range, not a significance vote | [notebook-robustness.md](./notebook-robustness.md) |
| 4 | **Research memory** | Local lexical recall over notebook entries, user notes and plan events across a project's chats, with source ids and digests; the read-only `notebook_search` tool gives the same recall to Kady and its specialists | [notebook-memory.md](./notebook-memory.md) |
| 5 | **Evidence packages** | A frozen, checksummed research-object ZIP (RO-Crate 1.1) for reviewers: selected claims, evidence, provenance, plans, results, a source-linked Methods scaffold and an explicit missing-information manifest | [evidence-packages.md](./evidence-packages.md) |
| 6 | **What next?** | Source-linked competing explanations and proposed tests with conditional predictions and decision branches; generation is one explicitly approved model call, and preferences are recorded decisions, not approvals to execute | [next-experiments.md](./next-experiments.md) |

## Design rules shared by every feature

- **Append-only history.** Existing notebook files are never migrated
  destructively; corrections are new entries that `supersede` old ones.
- **Narrative is authored, identity is derived.** Prose, evidence relationships,
  confidence and predictions are the author's interpretation. Only the server
  derives artifact identity and freshness, and only from bytes it hashed itself.
- **Bounded reads, visible gaps.** Every file read and hash has a budget, and an
  exhausted budget is reported as incomplete verification. Missing evidence is
  never converted into verified absence.
- **Scoped ids.** Entries are identified by session plus id in project views, so
  the same raw id in two chats cannot redirect a link or a navigation.
- **Lead/child parity.** The lead's in-process `notebook` tool and the vendored
  `kady-notebook` child package share one input schema (guarded by a parity
  test); harvested child references are namespaced and stay unverified.
- **Paid work is explicit.** Any model call or remote compute launched from the
  notebook needs a user approval bound to the exact reviewed content, and is
  budget-gated and ledgered like any other run.
- **Not a security or compliance boundary.** These are local, same-user records.
  They are not external preregistration, tamper-proof storage, or proof that a
  method was executed; see [limitations](./limitations.md).

## Still open

- **Async child run attribution.** Notebook entries harvested from a background
  specialist are left without a run id rather than borrowing a later run's; a
  durable launch-to-completion mapping is needed to stamp them correctly.
- **Nested subagents.** A specialist that itself delegates produces a grandchild
  session that is not harvested, for the notebook or for
  [provenance](./provenance.md).
- **Manuscript impact.** Change warnings cover directly cited artifacts and
  version-aware upstream lineage; propagating them into manuscript text is not
  implemented.
- **Numerical experiment ranking.** *What next?* priorities are qualitative. An
  information-gain optimizer would need an explicit likelihood, priors and
  utility, and its own validation.
