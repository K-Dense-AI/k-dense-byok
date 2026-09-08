# Living Lab Notebook

Kady's Living Lab Notebook is a real-time record of its work on your project. As Kady runs analyses, writes code, and makes decisions, it automatically logs structured entries to a center-panel "Lab Notebook" tab in the chat interface. You can watch entries appear as they're authored, thread hypotheses to the evidence that tests them, pin and comment on entries, add your own notes, review past sessions, export the full log (with artifacts), print it as a PDF, or generate a Methods-section draft from it.

## What gets logged

Kady logs entries through the `notebook` tool when it wants to record its work. Each entry can include:

- **Title** — a short name for the entry
- **Type** — one of: `hypothesis` (a testable assumption), `method` (a procedure), `observation` (findings or results), `decision` (a choice made), or `note` (miscellaneous)
- **Body** — optional Markdown text with details, context, or explanation
- **Code snippet** — optional code block rendered with syntax highlighting and a copy button; if the code references a file artifact, an "Open as file" button opens that source file in the preview panel
- **Confidence** — optional author-reported rating (`low`, `medium`, `high`), shown as a three-segment meter. It is not a calibrated probability or a server verification.
- **Tags** — keywords shown as chips; clicking one filters the notebook
- **Artifacts** — sandbox-relative file paths; images render as inline thumbnails, other files as clickable chips that open in the preview panel
- **Evidence links** — an observation can bear on multiple earlier hypotheses or decisions using `evidence: [{entryId, relation, rationale?, sessionId?}]`. Relations are `supports`, `challenges`, `inconclusive`, and `context`. Omit `sessionId` for local links. The existing `relatesTo` / `stance` pair still works.
- **Outcome and limitations** — optional `outcome` (`signal`, `null`, `inconclusive`, `technical-failure`) and `limitations` record what an analysis can and cannot establish.
- **Applicability and reconsideration** — optional `scope` identifies datasets/cohorts/conditions; `revisitWhen` records what would justify reconsidering a finding or rejected approach. These are authored conditions, not permanent facts or automatic actions.
- **Amendments** — `supersedes` corrects an earlier entry without deleting history.
- **Plan proposals** — `analysisPlan` on a hypothesis contains an editable draft, never an approval. The user reviews and freezes it separately.
- **Robustness proposals** — `robustness` on a hypothesis is a draft script/input/specification recipe. Only the scientist's explicit snapshot/budget approval starts Modal jobs.
- **Next-investigation proposals** — `nextExperiments` on a note compares explanations and predicted outcomes, explains decision consequences and required resources, and targets a saved hypothesis. It is never an observation or execution approval.
- **Scientific results** — `results: [{toolCallId, sessionId?}]` references persisted `scientific_result` cards. The tool returns its result id so the model does not need to repeat measurements.

Entries are author-stamped, timestamped, and stamped with the run that produced them automatically.

## Threading: hypotheses, evidence, amendments

The notebook is more than a log — entries link into an argument structure:

- An **observation** that tests a hypothesis points to it with an evidence link (or legacy `relatesTo` and stance). The hypothesis summarizes **all active linked evidence**: **Awaiting evidence**, **Supporting evidence**, **Challenging evidence**, **Conflicting evidence**, or **Inconclusive**. No single latest entry overrides conflicting findings. These labels describe authored interpretations, not scientific truth. Provisional live entries are visible immediately but do not count as evidence or supersede saved records until confirmed by the server.
- A **decision** can cite the observation that drove it; the reference line under the title (`↳ supports …` / `↳ refutes …`) is clickable and scrolls to the target.
- History is append-only: to correct an entry, Kady logs a new one with `supersedes`. The old card is struck through and dimmed, with links in both directions ("superseded by" / "amends"). Superseded observations do not count as active evidence. An amendment must explicitly restate its evidence links; links are never silently inherited.
- Expand **Inspect active evidence** to inspect supporting, challenging and inconclusive entries. Counts are not independent replications or probabilities. Technical failures are treated as context rather than negative scientific evidence. A null result is not automatically a challenge.
- Cross-chat ids are session-qualified in the project view. Missing/out-of-view references are identified rather than resolving to an unrelated entry with the same id.

## Artifact freshness and review warnings

New lead-agent notebook writes capture bounded **server-measured citation-time hashes** for directly cited files. On read/export, Kady checks current bytes and reports:

- **Unchanged** — matches the citation-time hash. This does not verify scientific validity or unchanged upstream inputs.
- **Changed** — bytes differ from the recorded citation. Review the interpretation against the new file.
- **Missing** — the cited artifact is no longer available.
- **Unverified** — no citation-time hash, an unsafe/unreadable path, a concurrent change during hashing, or a verification budget limit.

A **Needs review** warning appears on the entry and on hypotheses with direct active evidence citing changed/missing artifacts. It does **not** change the evidence stance or refute the claim. Expand **Artifact checks** for paths, reasons and check timestamps.

Hashes are not retained historical copies. Old notebooks and harvested child entries have no citation-time identity and remain unverified when files exist; no retrospective hash is promoted to citation-time proof. The file-preview Provenance panel remains available for execution lineage and upstream investigation. This check covers direct citations, not the whole transitive dependency graph.

Checks are asynchronous, request-local and bounded: 25 unique citations per entry, 100 unique file checks per read, 8 MiB per file and 32 MiB of hashing per request/capture. Recent entries receive the request budget first. Additional citations and exhausted budgets are visible as incomplete checks. Hidden files, traversal and symlink escapes are rejected.

## Frozen analysis plans and deviations

Use **Analysis plan** (or **Review proposed analysis plan**) on a saved hypothesis card, in either notebook scope:

1. **Prepare a plan.** Review the hypothesis, primary outcome, inclusion/exclusion rules, statistical model, multiplicity, QC/success criteria, stopping/sample-size rule, dataset paths and prior data exposure. Every field must be explicit, including unknown/not-applicable values. The exploratory/confirmatory intent and prior exposure are declarations, not independently verified facts.
2. **Review freeze preview.** The server captures bounded dataset identities and returns the exact plan to be approved. A preview expires after 15 minutes. Missing/oversized/unreadable datasets are clearly unverified and require a separate acknowledgement.
3. **Approve and freeze locally.** Explicit confirmation is required. The server rechecks dataset identities, source entry and journal head. If data or history changed, it rejects the request and requires a new review; it never silently approves a replacement. Unknown identities cannot be proven stable, even when acknowledged.
4. **Revise without rewriting.** A revised plan requires a reason and another approval. Prior revisions remain intact with their own timestamps and dataset hashes.
5. **Record deviations.** Select the exact frozen revision and changed field, record what was actually done, why, and whether the decision was made before or after inspecting results (or unknown). The planned value is read from the frozen record, not supplied by the caller. **Correct this deviation** appends a correction while retaining the original.

This is a **local user-confirmed record, not external preregistration or proof of data-naivety**. Freezing does not pause an active analysis or enforce a procedure, and recorded intentions are not evidence that the method was executed. Deviations are user-entered/self-reported; the agent may report changes in notebook prose but does not automatically create approved plan/deviation events. No new AI call or compute job is made by these controls.

The journal lives under `.kady/notebook/plans/<hash-of-session-and-entry>/`, one exclusively published JSON file per event. Atomic exclusive publication and head preconditions prevent concurrent writers from overwriting one another, including across processes. Records carry content digests and a previous-event digest; corrupt/gapped retained records fail visibly rather than being reset. Maximums: 256 events per hypothesis, 128 KiB per record, and 64 live previews per source. Plan dataset hashing uses the artifact budgets above. Publication requires filesystem hard-link support (normal APFS/ext4/NTFS); unsupported filesystems fail rather than falling back to unsafe overwrites.

These records are **not an OS-level security or compliance boundary**: a same-user shell can edit local files or call the API. Use an external registry for independently verifiable preregistration. Dataset hashes do not retain historical data copies.

## Linked scientific-result cards

On an observation with `results` references, **View saved result** loads the canonical successful `scientific_result` tool-result envelope from its source session. The existing table/statistics/QC/plot viewer renders the saved values; they are not regenerated from notebook prose.

- New lead-agent references pin a server-derived content digest when the persisted source can be fully checked.
- A changed pinned result is flagged and its replacement is **not displayed as the original evidence**.
- A legacy/unpinned reference can show the currently saved card, explicitly labelled unverified at citation time.
- Missing, ambiguous, malformed, changing or oversized source logs produce visible unavailable/unverified states instead of guessing. A valid card located in an otherwise partially readable log (for example, one containing large image-message rows) can be inspected as unverified, but is not pinned: uniqueness could not be fully checked. Changed pinned content is still withheld. Scans are bounded to 64 MiB total per capture/lookup and 256 Ki characters per log line.
- File/image previews still open **current** sandbox artifacts, not historical copies. A matching result digest verifies stored content identity, not scientific validity.
- Explicit cross-session references are project-scoped. Child-local references are marked unindexed and never looked up in the parent log, even if ids collide; harvested references to explicit parent/project sessions remain unpinned.

## Stress-test a finding

On a saved hypothesis with a frozen local analysis plan, **Stress-test finding** prepares a private snapshot and quote for 2–16 defensible Python analysis variations. Review the exact script, input identities, seeds, parameters and maximum estimated sandbox commitment before explicitly authorizing remote upload/execution. Nothing runs remotely during preview.

The full batch must have durable budget holds and job records before any remote work starts. All specifications and terminal attempts—including admission failures, cancellations, missing outputs and QC failures—are preserved. The plot and descriptive range/median use successful valid QC-pass results, not significance voting or independent-replication counts. Outputs are read from retained, checksummed Modal staging; current sandbox files may have changed. Compute-generated notebook citations retain the recorded output identity and can show later-file review warnings.

Use **Cancel remaining jobs** to stop pending work. Retrying requires a **New reviewed workflow**, with a new snapshot, quote and approval. Uncertain launches are not automatically repeated; missing committed job records retain their budget holds rather than being assumed unspent. These are estimated sandbox commitments, not provider invoice caps or an OS-level security boundary.

See [notebook-robustness.md](./notebook-robustness.md) for the script contract, limits, billing caveats, exports and recovery behaviour.

## What should we test next?

**What next?** on a saved hypothesis opens source-linked planning proposals, not a separate Conclusions view. Compare 2–4 explanations and 1–6 proposed tests with conditional predictions, outcome→decision branches, controls, an inconclusive-result action, requirements and limitations. Existing-data checks are preferred; new collection needs a justification. Priorities/time/cost are qualitative judgments—not calibrated probabilities, computed information gain or provider quotes.

Opening/refreshing makes no model call. **Generate a source-linked proposal** requires explicit approval of one normally billed planning-model call using bounded project excerpts and current constraints; invalid returned responses are also ledgered, and interrupted requests are not automatically repeated. **Record planning preference** appends a reasoned prioritize/defer/reject decision against exact proposal/context versions. Changed/unverified context requires acknowledgement. Neither action launches an experiment, approves remote execution, freezes a plan or authorizes collection.

Proposals/preferences remain context rather than supporting/challenging findings, cannot retire actual scientific evidence, and are excluded from performed-Methods drafts. They retain source links, planning-time identities, historical preferences and exports. See [next-experiments.md](./next-experiments.md) for the workflow, bounds and recovery caveats.

## Project research memory

**Research memory** in the notebook header searches saved records across project chats, including decisions, failures, null/inconclusive results, standalone user notes and validated frozen-plan/deviation records. Hits carry exact source ids/digests, excerpts, applicability, reconsideration conditions, corrections and direct artifact-check warnings. Read the original source before reuse; partial scans and legacy unlabeled outcomes are explicitly qualified.

The agent's read-only **`notebook_search`** tool provides the same bounded recall to new lead sessions and supported child specialists. It is a visible tool retrieval, not hidden context injection or an AI-authored fact store. **Copy bounded recall for chat** only copies qualified context; it does not send a message or authorize execution. Indexing is local, but agent-retrieved text enters the selected model's normal context.

See [notebook-memory.md](./notebook-memory.md) for coverage, budgets, privacy and source-link semantics.

## Context compaction that keeps the science

Long analyses outgrow a model's context window. Pi then **compacts** the
conversation: older messages are replaced by a summary and the recent part is
kept verbatim. Kady steers that step so the summary does not lose what a
scientist needs:

- A **state block comes first**, derived from Kady's own records rather than
  written by the model: the latest frozen analysis plan, the last twenty
  notebook entries with their ids, the ids of every `scientific_result` card,
  and the environment snapshot in effect. Because it is read from the notebook,
  plan journal and provenance log, compaction cannot invent or silently drop
  state.
- The **narrative summary** is generated under science-focused instructions:
  keep hypotheses and their status, exact parameters and seeds, file paths,
  numeric results with units, decisions and their reasons, and open questions.
- The summary call is billed like a turn and appears in the session's cost.
- A compaction shows up in the chat as a thin **"Context compacted"** divider
  with the token count that was summarized.

Compaction runs automatically near the limit. You can also trigger it from the
context gauge next to the model picker ("Compact now", scissors icon) while no
run is streaming — for example before switching to a new sub-question. In the
project settings (edit project) you can turn automatic compaction off and tune
how many tokens are reserved for the reply and how many recent tokens stay
verbatim; these apply to every chat in the project.

If the science-aware step fails (for example the model's credentials are
missing), Pi's default compaction runs instead, so a compaction is never lost
to a Kady error.

## Your layer: pins, comments, and notes

Agent entries are immutable, but you can annotate them:

- **Pin** entries with the star button; a "Pinned" filter chip shows only pinned entries.
- **Comment** on any entry (the comment thread lives under the card).
- **Add your own notes** with the composer at the bottom of the notebook; they appear in the timeline attributed to "You".

Annotations persist in a sidecar file next to the notebook (`.kady/notebook/<sessionId>.annotations.json`) — the agent's record is never modified.

## Where it lives

Entries persist as a JSON Lines file (one entry per line) at:
```
sandbox/.kady/notebook/<sessionId>.jsonl
```

Each chat tab (session) has its own notebook; closing the tab does not delete entries — they remain in the project's sandbox and can be reopened from the session history.

## In the UI

- **Center-panel tab.** An always-pinned "Lab Notebook" tab appears next to file-preview tabs in the center panel, fed live from the active chat tab's stream.
- **Real-time streaming.** As Kady writes entries, they appear in the notebook with a pulsing "writing…" indicator.
- **Timeline rail.** Entries sit on a vertical rail with type-colored nodes. Dividers mark new runs, and day dividers appear when a notebook spans multiple days.
- **Scrolling that respects you.** The view sticks to the newest entry only while you're at the bottom; scroll up to read and it stays put, with a floating button to jump back down.
- **Filters and search.** Header chips filter by type (with live counts); a search box matches titles, bodies, and tags.
- **Two view modes.** "By agent" groups entries into collapsible per-agent lanes (each with a stable accent color); "Timeline" interleaves all agents chronologically with a per-entry author badge.
- **Scope toggle.** "This chat" shows the active session; **"All chats" is the default**, showing a merged timeline with session dividers (pins/comments/notes remain chat-scoped; analysis-plan controls also work here). The active chat's entries merge live; background changes refresh every 5 seconds while active/awaiting child work, otherwise every 30 seconds while visible. Focus/reconnection via focus and visibility events refreshes the record too. Failed refreshes leave a visible warning and Retry action instead of silently switching scope.
- **Chat ↔ notebook links.** Notebook writes appear in the chat transcript as compact chips with "View in notebook"; each notebook card has a "View in chat" button that scrolls the transcript to the moment it was logged. Both directions flash the target.

## Subagent lanes

The notebook groups entries into collapsible per-agent lanes. The lead agent's entries appear in the "Kady (lead)" lane first, followed by a lane for each subagent that contributed entries (labeled by agent name, with an entry count and accent color).

Subagent entries are harvested when the subagent finishes, as a batch, not live. While async/background subagent work is outstanding, the notebook polls every few seconds so late entries surface without a reload.

**Limitation:** Nested subagents (depth > 1) are not harvested in this version — only direct children contribute.

## Export and print

The header's **Export** menu offers:

- **Markdown (.md)** — a lab record with attribution, tags, confidence, and thread links per entry.
- **Bundle with artifacts (.zip)** — the Markdown plus every referenced artifact file under `artifacts/`, with links rewritten so figures resolve inside the bundle. Missing artifacts are noted rather than breaking the export.
- **JSON (.json)** — the raw entries for programmatic use.

Frozen revisions, deviations and scientific-result source identifiers/content digests are preserved in JSON, Markdown/ZIP and print. Notebook exports do not bundle canonical Pi session logs or historical plan datasets; for reviewer-ready packaging with version-matched artifacts use an [evidence package](#reviewer-evidence-packages).

The **PDF** button opens a print-ready view — Markdown bodies fully rendered, figures embedded, lanes, threading, pins, and comments included — and triggers your browser's print dialog. If your browser blocks the popup, a notification tells you.

## Reviewer evidence packages

**Evidence package** in the notebook header (or on a saved hypothesis/observation/decision) prepares a frozen, source-linked research-object ZIP. Select roots and review the automatically bounded supporting/challenging/amendment context, recorded provenance, plans/deviations, canonical result cards and artifact-version table before downloading.

Known historical hashes are matched against retained package snapshots, relevant Modal/robustness copies, or current bytes. Unavailable historical versions are explicit; optional current comparison copies never become original evidence. Packages include a source-linked Methods scaffold, missing-information manifest, checksum verifier and base RO-Crate 1.1 metadata. They do **not** run analyses, probe environments, call a model, submit compute or certify reproducibility.

Storage controls distinguish removing a package from pruning unreferenced historical snapshots. No original research file is deleted. See [evidence-packages.md](./evidence-packages.md) for limits, integrity, rights/privacy and recovery semantics.

## Methods draft

The **Methods draft** button (with a confirm step — it makes one AI call billed to your project budget) summarizes active (not superseded) method, decision, and observation entries into a manuscript-style Methods section. Its context includes frozen-plan history, deviations, scientific-result references, evidence links, limitations, outcomes and artifact-check warnings, and the prompt requests source entry ids and explicit missing information. A plan alone cannot trigger a Methods AI call without a method, observation, decision or recorded deviation; plans describe intentions, not performed methods. Oversized context is explicitly marked partial. These are drafting instructions, not a claim that generated citations have been independently verified. The draft is saved as `methods_draft_<sessionId>.md` in the sandbox and opens in the preview panel. The call is budget-gated and ledgered under the `methods-draft` session id in project costs.

## Behind the scenes

The `notebook` tool is a **non-interactive** in-process agent tool. It briefly awaits bounded asynchronous citation hashing, saves the entry, and continues without waiting for user input or blocking other chat streams. Each entry arrives in the chat UI as a `tool_start` SSE frame, and a synthetic `run_start` frame carries the run id so live entries group by run before the authoritative refetch. The tool result returns the entry's id so Kady can reference it in later `relatesTo`/`supersedes` links.

## Caveats

- **Subagents log too, but as a batch.** The lead agent gets the `notebook` tool in-process; subagents get it via the vendored `kady-notebook` Pi package, and their entries are harvested into the parent notebook when each child finishes. Builtin `pi-subagents` specialists pin a `tools:` allowlist that would otherwise strip the notebook tool; the backend seeds `subagents.agentOverrides.<name>.tools` to compensate. A user who pins their own `tools` override for a builtin agent takes responsibility for including `notebook`.
- **Run attribution for async children.** Async harvested entries are left without a run id rather than incorrectly borrowing a later active run. A durable originating-launch correlation remains a later improvement. Synchronous results retain active-run attribution.
- **Session-scoped storage; project-scoped default view.** Each chat tab keeps its own notebook; "All chats" merges them live, with source-scoped plan controls. Pins and notes are still edited in "This chat". Use that scope for the "View in chat" action, which is intentionally hidden for project entries to avoid jumping into the wrong transcript.
- **Missing artifacts.** If an artifact path no longer exists, the chip shows a "not found" state (and zip/Markdown exports note it) without breaking the entry.

## Examples

A typical data-analysis session might produce entries like:

| Type | Title | Links |
|------|-------|-------|
| Hypothesis | Count matrix normalization improves variance stability | — |
| Method | Load and preprocess counts | — |
| Observation | Size factors flatten mean-variance trend | supports → the hypothesis |
| Decision | Use Wald test for DE | relates to → the observation |
| Note | Volcano plot thresholds | — |

Each entry can include code, artifact links, author-reported confidence, and tags. The hypothesis card shows **Supporting evidence** once the observation lands, **Conflicting evidence** if an active challenge also exists, and **Needs review** if directly cited artifacts change. Notebook code is authored narrative; execution provenance is what establishes what actually ran.

[notebook-roadmap.md](./notebook-roadmap.md) gives a one-page map of the notebook's evidence features and the design rules they share.
