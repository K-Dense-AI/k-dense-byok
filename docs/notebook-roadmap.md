# Evidence-aware notebook implementation roadmap

User-approved scope: implement the seven-feature roadmap in stages, enhancing the existing hypothesis cards rather than introducing a competing Conclusions view.

## Delivery stages

1. **Evidence and freshness foundation (implemented)**
   - Multiple typed evidence links, with backward-compatible legacy threads.
   - Conflicting/inconclusive evidence remains visible; no latest-entry-wins verdict.
   - Superseded observations no longer count as active evidence; counts are not independent replications or probabilities.
   - Server-derived, bounded direct-artifact freshness checks. Unknown is not current; changed is not scientifically false.
   - Live project notebook with scoped identities, refresh/error states and race-safe requests.
   - Export parity, adversarial/regression tests, documentation.
2. **Frozen analysis plans and structured results (implemented)**
   - User-approved, immutable plan revisions and append-only deviations.
   - Dataset identity and prior exposure, primary outcomes, exclusions, model, multiplicity, QC and stopping rules.
   - References to persisted scientific-result cards (not a second model-authored copy of measurements).
   - Internal freeze clearly distinguished from external preregistration.
3. **Bounded robustness workflows (implemented)**
   - Preview and user approval of defensible specifications and a worst-case budget.
   - Durable execution through existing Modal jobs; persist all attempted/failed specifications.
   - Effect/uncertainty distributions, not a significance vote or a claim of replication.
4. **Source-linked project research memory (implemented)**
   - Query relevant prior decisions, failures, null and inconclusive results with scope and original entry links.
   - Stale/superseded records remain qualified; technical failure never becomes evidence of no effect.
   - Explicit, bounded retrieval into subsequent sessions; no silent permanent conclusions.
5. **Reviewer-ready evidence packages (implemented)**
   - Selected claims, evidence, provenance, plans/deviations, source-linked Methods and an explicit missing-information manifest.
   - Selective historical artifact snapshots, storage quotas and checksummed installation.
   - RO-Crate packaging where supported; packaging is not verified reproducibility.
   - Clean reruns require approved recipes and isolation; never replay arbitrary recorded shell commands automatically.
6. **Decision-oriented next-experiment proposals (implemented)**
   - Competing explanations, predicted outcomes, decision consequences, required resources and cost.
   - Prefer existing-data checks before new collection.
   - Qualitative rankings initially; numerical information gain only with explicit priors/model/utility.

The change-impact feature grows across stages: direct cited-artifact warnings in stage 1; version-aware upstream propagation and manuscript impact once claim/result/package references exist. Do not imply full historical snapshots, transitive completeness, or automatic reproduction in stage 1.

## Cross-cutting acceptance criteria

- Preserve append-only history and existing notebook files without a destructive migration.
- Treat narrative, evidence relationships and confidence as authored interpretation. Only the server derives artifact identity/freshness.
- Project/session-scoped ids prevent cross-chat collisions and wrong-target navigation.
- Bound file reads/hashes and report incomplete verification; never silently convert missing evidence to verified absence.
- Lead/child schema parity, harvest namespacing, JSON/Markdown/print preservation.
- Test conflicting, superseded, duplicate, malformed, missing, inferred and retrospectively hashed evidence; stale async responses; project switches; failed verification.
- Paid model/compute work remains explicitly budget-gated and user-approved.

## Stage 1 verification

- Backend typecheck passed; full backend suite: 689 passed, 1 skipped.
- Frontend typecheck passed; full frontend suite: 566 passed.
- Frontend production build passed, with no test-only routes shipped.
- Headless Chrome visual checks exercised the actual hypothesis/evidence cards at wide and narrow widths; the temporary fixture and local dev server were removed afterward.
- Tests cover conflicts, amendments (including same-millisecond ordering), duplicate cross-chat ids, direct freshness propagation, historical/harvest uncertainty, bounds, unsafe/symlink paths, model-forged metadata, export parity, and stale/failed requests.

These checks verify stage 1 only. Stages 2–6 were implemented subsequently (below), with their own validation and limitations.

## Stage 2 delivery

- Hypothesis cards accept model-authored `analysisPlan` drafts; the scientist can prepare/edit, review a server-held preview and explicitly approve a local freeze. A model tool call cannot create approval history.
- Dataset hashes are captured at preview and rechecked at confirmation; changed data/source/history or expired previews require another review. Unknown identities need a separate acknowledgement and never become verified through approval.
- A source-scoped journal uses exclusively published, immutable JSON event files and head preconditions. Concurrent writers (including separate processes) cannot overwrite one another. Revision reasons, deviations against a specific frozen revision, and append-only corrections are retained.
- `results` links resolve canonical successful persisted `scientific_result` envelopes. The notebook stores source references/content digests, not copied measurements. Changed pinned results are not substituted; incomplete/ambiguous logs and unindexed child-local references remain visibly unverified.
- JSON/Markdown/ZIP/print preserve plan histories and result identifiers/digests. Methods context includes actual plan/deviation records with explicit intent-versus-execution guidance; a plan alone cannot trigger a performed-Methods AI call.
- Plans do not pause/enforce analysis, and deviations are user-entered in this stage. Local timestamps/hash chains are not external preregistration, proof of data-naivety, tamper-proof storage or a same-user shell security boundary. Canonical session logs and historical dataset bytes are not bundled by ordinary notebook export.

### Stage 2 verification

- Backend typecheck passed; full backend suite: **723 passed, 1 skipped**.
- Frontend typecheck passed; full frontend suite: **582 passed**.
- Frontend production build passed; no visual-test routes remain.
- Real Chromium visual checks covered the plan approval preview and saved-result dialog, including a 430px emulated viewport with no horizontal overflow. Temporary fixtures, dev server and isolated browser were removed/stopped afterward.
- Tests include explicit/unknown-data approvals, expired/stale previews, source/project isolation (including missing-project fallback refusal), same-head concurrent writes across separate processes, immutable revision/deviation histories, corrupt records, symlink escapes, model-forged metadata, bounded result scans with large image rows, changed pinned results, child-local id collisions, exports and Methods intent-versus-execution safeguards.

## Stage 3 delivery

- Hypotheses accept a `robustness` proposal; the user prepares/reviews a private byte snapshot, a common metric/unit, 2–16 specifications/seeds/rationales, exact package pins, and the full estimated sandbox commitment.
- Explicit approvals cover code/specification review, remote data upload/execution, estimated costs, and any originally unverified plan identities. Known frozen-plan dataset identities and current source/plan heads are checked; copied authorizations are project-bound.
- A server-only Modal admission path records protected intent, reserves the entire batch, persists stable jobs, then publishes one shared admission gate before scheduling. Partial admission never starts remote work. Private snapshots and actual uploads are checksum-checked before analysis.
- Every approved specification remains in the workflow. Authorization and terminal attempts are logged as compute entries without changing hypothesis verdicts. Successful, valid QC-pass estimates feed a descriptive range/median and interval plot; failure/invalid/missing/QC exclusions remain visible.
- Cancellation is durable; managed jobs cannot bypass review through generic retry. Startup/credential-restoration recovery resumes safely recorded work, but uncertain launches are not re-executed. Unknown launch/cleanup consumes the conservative approved estimate; missing committed job records retain protected holds.
- Workflow JSON and Markdown summary exports plus normal notebook exports preserve definitions/attempts. The image recipe is not an immutable environment guarantee; arbitrary code/side effects are not audited, estimates are not invoice caps, and the existing single-backend Modal ownership boundary remains.

### Stage 3 verification

- Backend typecheck passed; full backend suite: **744 passed, 1 skipped**.
- Frontend typecheck passed; full frontend suite: **597 passed**.
- Production build passed; no visual-test routes remain.
- Chromium checks covered approval and mixed-outcome results at 1200px and 430px. Dialog/page widths stayed within the viewport; the plot/table deliberately scroll horizontally on narrow screens. Temporary dev server, fixture and isolated browser were stopped/removed.
- Tests cover no-work previews, explicit approvals, stale/changed files, immutable snapshot use, whole-batch budget rejection, partial storage failure, duplicate approvals, cancellation, invalid/missing/QC-failed results, upload checksums, bounded outputs, restart/partial-admission recovery, uncertain launch/cleanup accounting, missing-record hold protection and cross-project authorization copying.
- Remote lifecycle tests use a fake Modal adapter. **No paid Modal jobs were launched**; live provider integration remains the explicitly opt-in test.

See [notebook-robustness.md](./notebook-robustness.md) for limits, Python contract and operational caveats.

## Stage 4 delivery

- The project notebook header offers local, lexical search over saved notebook entries, standalone user notes and validated plan/deviation records. Original source ids/digests, applicable scope, reconsideration conditions, outcomes and correction links are preserved; no new AI fact summary is authored.
- Source reads detect edits since search. Known retired records stay qualified, partial coverage yields unknown currentness/evidence status, and direct artifact checks never become scientific verification or transitive-lineage claims.
- New lead sessions and child specialists receive the read-only `notebook_search` search/read tool. Retrieval is an explicit visible tool call, not hidden system-prompt injection. Child calls use a bounded, non-redirecting loopback bridge; builtin allowlist reconciliation preserves the new read tool without restoring removed mutation tools.
- The UI supports bounded recall/citation copying and session-qualified notebook navigation. Copying is not sending, logging a new finding or authorizing new work. Source previews render plain text rather than activating embedded markup.
- All source IO, corpus size, prefixes, artifact checks and tool/clipboard responses are bounded with visible omissions. No auth-store, raw-chat, external search or embedding/model-indexing call is made; agent-returned text still uses the selected model's normal context and billing.

### Stage 4 verification

- Backend typecheck passed; full backend suite: **769 passed, 1 skipped**.
- Frontend typecheck passed; full frontend suite: **610 passed**; focused navigation/source-view tests also passed after the final UX adjustment.
- Production build passed. Chromium checks covered search and source views at 1200px/430px with no page/dialog horizontal overflow. Temporary visual route, dev server and isolated browser were removed/stopped.
- Tests cover cross-chat/project ids, explicit outcome labels, supersession/conflicting evidence, editable-note digests, plan/deviation integrity, direct artifact changes, malformed/ambiguous/oversized/symlink sources, bounded tool output, no notebook-write feedback, child loopback/redirect safeguards, builtin allowlist migration, read-only provenance and stale UI responses/navigation.
- No model, embedding or paid compute call is made by indexing/search; normal model-context usage still applies when agents request recalled text.

See [notebook-memory.md](./notebook-memory.md) for source families, bounds and trust limitations.

## Stage 5 delivery

- Selected notebook roots produce a bounded supporting/challenging/amendment closure, original source JSON, selected user annotations, validated plans/deviations, canonical result resolutions, robustness records and observed provenance/environment metadata.
- Artifact versions are resolved by their recorded identity basis. Content-addressed local snapshots and retained Modal/robustness bytes can recover prior versions; absent history is never silently replaced by a current file. Optional current/unverified copies remain explicitly labelled.
- Packages contain an explicit gap manifest, deterministic source-linked Methods scaffold, base RO-Crate 1.1 descriptor, file checksums and an optional isolated-Python integrity verifier. No analysis, environment probe, model call, dependency install or remote compute is executed; reproduction remains a separate approved activity.
- ZIP inputs are checksum-verified while streamed into the archive; server and browser verify the reviewed download identity. Project-bound immutable previews, strict archive names, path/symlink/private-file guards, bounded IO and storage quotas protect the workflow.
- User review distinguishes local preparation, sensitive-data/rights acknowledgement, downloading, package removal and pruning unreferenced snapshots. Originals are not deleted; corrupt references block unsafe pruning. The existing lightweight ZIP export also now enforces realpath/visibility checks for artifact links.

### Stage 5 verification

- Backend typecheck passed; full backend suite: **785 passed, 1 skipped**.
- Frontend typecheck passed; full frontend suite: **615 passed**.
- Production build passed. Chromium checks covered package review/storage at 1200px/430px with no page/dialog overflow; the version table deliberately scrolls on narrow screens. Temporary fixture, dev server and isolated browser were removed/stopped.
- Tests verify evidence/amendment closure, multiple versions of a path, historical recovery from the vault and Modal staging, unavailable-original handling, retrospective/unknown identities, inferred provenance and stored environments, plan/deviation and scientific-card inclusion, no raw-chat inclusion, download acknowledgements/checksums, safe deletion/pruning, symlink/credential/path guards and copied-project rejection.
- The packaged static checker was exercised with `python3 -I verify.py` against real ZIP contents and detected tampering. Captured analysis code was not executed; no model or paid compute run was launched by packaging.

See [evidence-packages.md](./evidence-packages.md) for the archive structure, bounds and the distinction between integrity and reproducibility.

## Stage 6 delivery

- **What next?** enhances saved hypothesis cards with source-linked competing explanations, conditional predictions under each explanation, outcome→decision branches, an inconclusive-result action, controls, required inputs/resources, qualitative time/cost and limitations. Existing-data checks are preferred; new collection needs an explicit rationale and prerequisites.
- Opening/reviewing is local and read-only. One-shot proposal generation needs explicit model-call approval and a matching project/source context digest. Returned invalid/incomplete responses are ledgered; local request intents/results prevent automatic repeat calls after a lost response or restart. Unknown provider outcomes remain unknown rather than assumed free.
- Native lead/child notebook tools can author structured proposals, not verification/approval fields. Child-local references are namespaced; harvest-time context remains unverified. Predictions/preferences are context only, cannot retire actual evidence, and are excluded from performed-Methods inputs.
- Planning-time file hashes, source record digests, changed/missing/incomplete checks and context changes during generation remain explicit. Fresh source reads carry expected digests. Prior proposals/preferences are excluded from generation context, preventing a self-reinforcing evidence loop.
- Explicit user prioritize/defer/reject preferences bind exact proposal/context versions, require reasons and acknowledgement of changed/unverified context, and preserve append-only history. No preference freezes a protocol, reserves execution money or launches work. Old-version preferences are not applied to an edited proposal.
- Research memory, JSON/Markdown/ZIP/print and evidence-package source graphs retain qualified planning records. Numerical information-gain optimization, empirical prediction calibration, automatic execution and provider invoice caps are not claimed.

### Stage 6 verification

- Backend typecheck passed; full backend suite: **808 passed, 1 skipped**.
- Frontend typecheck passed; full frontend suite: **633 passed**.
- Production build passed with only the normal app routes; no visual fixture was shipped. `git diff --check` passed.
- Chromium checks covered source/proposal review, conditional prediction/decision tables and the changed-context preference form at 1200px and 430px. Page/dialog widths stayed within the viewport; tables deliberately scroll inside their cards. The temporary fixture, dev server and isolated browser were removed/stopped.
- Tests cover source/project identity, incomplete/missing/changed files, frozen-plan/deviation selection, explicit model approval and budgets, storage failure before dispatch, charged invalid/truncated responses, invented citations, concurrent generation, lost/uncertain receipts, append recovery, immutable preference history, old-version choices, malformed/coerced metadata, lead/child parity and namespacing, evidence/Methods exclusions, package source links, export escaping and stale UI responses.
- No paid model or Modal call was launched during verification. Planning-call lifecycle tests use a fake completion function; live provider/Modal testing remains opt-in.

See [next-experiments.md](./next-experiments.md) for controls, schema, limits, billing and interrupted-request behaviour.

## Deferred foundation detail

Async-child originating-run correlation needs a durable launch-to-completion mapping using the installed subagent runner's identifiers. Until that mapping is implemented, do not stamp async completion with a later in-flight run. Nested subagent harvest remains out of scope of stage 1.
