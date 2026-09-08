# Decision-oriented next investigations

**What next?** on a saved hypothesis card helps answer “What could distinguish the competing explanations, and which result would change our decision?” It is a planning surface, not a new Conclusions view or an execution agent.

## Scientist workflow

1. Open **What next?**. Opening/refreshing reads local records; it makes no model or compute call. Historical proposals remain available after a hypothesis is superseded, but new generation/preferences require its current version.
2. Inspect **Grounding context**: selected original notebook excerpts, validated plan/deviation records, source ids/digests, scope, limitations, corrections and direct artifact checks. The selection is bounded, not exhaustive project evidence. Prior next-investigation proposals and preferences are excluded from this scientific context to avoid feedback and self-invalidation.
3. To generate ideas, expand **Generate a source-linked proposal**, state current constraints and explicitly approve **one planning-model call** with the selected chat model (or the configured default). Normal provider usage applies. The call receives bounded excerpts, not arbitrary raw chat, credentials, analysis tools or an execution environment. Fusion is not supported by this one-shot endpoint.
4. Review the competing explanations and proposed tests. Every test names its measurement, controls, predicted outcome under **each** explanation, at least two possible outcome→decision branches, and a separate action if the result is inconclusive. Required inputs/resources and their availability assumptions remain explicit.
5. **Record planning preference** to prioritize, defer or reject a candidate, with a reason. This appends a user decision bound to the exact proposal and current context digests. Changed/unverified proposal context requires an acknowledgement. It does **not** freeze a plan, approve a budget, submit compute, order supplies, authorize recruitment or consent to data collection.
6. To proceed, prepare/review a current analysis plan and obtain all applicable resource, ethics and execution approvals separately. Computational sensitivity workflows still use **Stress-test finding** and its own current snapshot/budget approval. Copying a planning brief does not send it to a model or launch work.

New generations do not silently replace earlier proposals. Native notebook amendments can supersede an older proposal, while preferences retain their original proposal/context identities. A preference for an edited older proposal version is shown as history, not the latest preference for its replacement. Source links carry expected record digests when available and open the read-only source response, which reports edits since capture.

## Scientific interpretation

- Predictions are **conditional expectations, not observations or validated predictions**. A result matching an expectation would still need appropriate controls, uncertainty assessment and alternative explanations.
- Prefer useful checks of existing data before new collection. New-data candidates must explain why existing data are insufficient. Dependencies appear before follow-ups; equal qualitative priorities prefer existing-data checks over literature checks and new data.
- Priorities, time and cost are **qualitative author judgments**, not probabilities, calibrated confidence, computed information gain, power analyses or provider quotes. There is no numerical Bayesian design/utility optimizer in this stage; one would require an explicit likelihood/model, priors and utility and its own validation.
- Recorded null, inconclusive and technical-failure outcomes keep their distinct meanings. Schema validation checks structure and references; it cannot prove that a prediction is correct, two explanations are scientifically exhaustive, or a proposed design is feasible or ethical.
- Proposal/preference links count only as **context**. They cannot support/refute a hypothesis or retire an actual scientific record. Actual performed methods and observed results must be logged separately.
- `current` means the bounded planning context still matches its recorded identities—not that a hypothesis or proposal is scientifically valid. Changed identities yield `changed`; incomplete checks or missing/unsafe/oversized data remain `unverified`. Legacy citation-time uncertainty is not removed by a later planning-time file hash.

## Agent authoring and source identities

The lead and child `notebook` schemas accept `nextExperiments` **only on note entries**, targeting a saved hypothesis. Required structure:

- `target`, `question`, `decision`, `existingDataAssessment`;
- 2–4 `explanations` with unique ids, labels, descriptions and exact sources;
- 1–6 `experiments` with unique ids, kind, qualitative priority/rationale, sources, acyclic `dependsOn`, method, measurement, controls, predictions, decision branches, inconclusive action, required inputs/resources, qualitative time/cost rationales, limitations, and `whyNewData` for collection.

Sources are `notebook`, `user-note` or `plan-event` references; plan events retain `eventId`. Omitted source sessions mean the proposal's session, not whichever chat happens to read it later. Use `notebook_search` for exact source identifiers before authoring. Unknown sources stay unverified; the one-shot generator refuses references outside the actual prompt's selected sources.

Server metadata (`proposalOnly`, `nextExperimentBinding`, `nextExperimentDecision`) is not in either tool's input schema. The lead binds authored proposals to source record versions it can observe, without pretending to have captured everything the model originally saw. Child-local references are namespaced during harvest; explicit project-session references remain explicit. Harvested context is always unverified at authoring time. Invalid child proposal payloads cannot become positive/negative evidence.

## Persistence, costs and interrupted requests

Proposals/preferences are ordinary append-only rows in `.kady/notebook/<sessionId>.jsonl`. Generated proposal ids start `next-experiments:`; user preference ids start `experiment-choice:`. A generation records the selected model, reported project spend, source/context digests, planning-time file identities and whether evidence changed while the model answered. **Hashes are not retained historical bytes.** This feature neither snapshots the whole environment nor archives all past model-input text.

One-shot usage is ledgered under session id **`next-experiments`**, with the existing billing classification. Returned refusals, incomplete responses and invalid JSON are still ledgered; no validation failure triggers an automatic model retry. The project commitment/spend cap is checked before cap-counted calls, as with Methods drafting. This is not a strict worst-case model reservation or a provider invoice/quotas guarantee; a call already admitted can add usage beyond the remaining cap. Experiment effort labels are never used as executable budgets.

Before dispatch, an exclusively published local intent is written under:

```
.kady/notebook/next-experiment-generations/<source-hash>/<request-uuid>/
  intent.json
  outcome.json   # confirmed success or failure, when available
```

A completed request id returns the same result/failure without another model call. A success receipt can restore a missing notebook append, but refuses different/ambiguous existing content. An intent with no confirmed outcome is **not automatically repeated after restart**. It may represent a still-running or interrupted call; provider usage can be unknown if no complete response arrived. **Check request status (no retry)** is read-only. Inspect the notebook and cost ledger before explicitly approving a new request. Receipt publication uses the same local filesystem hard-link primitives as frozen plans; unsupported storage fails before dispatch.

These protections assume the existing single-backend notebook owner, not distributed exactly-once billing. Local files and localhost APIs are not a security boundary against same-user shell tools. A user/agent with shell access can edit them; no tamper-proof or regulatory-compliance claim is made.

## Bounds and integration

- Reuses memory's 32 MiB scan / 512 files / 100 sessions / 5,000 records and safe-path rules.
- Selects up to 18 two-hop direct notebook records, the current frozen plan plus up to three other plan/deviation records, then lexically relevant context, capped at 24 sources. Missing/bounded links and additional plan history are explicit.
- Each excerpt is capped at 1,800 characters; the model's serialized source section is capped at 30,000 UTF-8 bytes. The active frozen plan is prioritized after the hypothesis. Metadata/direct checks are additionally bounded; omitted sources/checks are signalled. The review shows a superset of the excerpts the model may receive, not an exhaustive corpus.
- Direct artifact health uses the existing read budget; a separate planning-identity capture checks at most 25 paths, 8 MiB/file and 32 MiB total. Neither checks transitive execution lineage.
- At most 6,000 output tokens requested; model JSON at most 128 KiB. Each hypothesis retains at most 100 planning-call receipts (384 KiB per outcome read). No automatic receipt deletion or repeat admission on uncertainty.
- Proposal history displays the newest 24 matching records within the bounded scan. Preferences and historical versions are retained rather than overwritten.
- JSON/Markdown/ZIP/print preserve structured proposals, context bindings and preference metadata. Research memory renders proposal fields as qualified planning text, never hidden permanent conclusions.
- Evidence packages preserve original proposal/preference rows and notebook/plan-owner source links as **planning context**, not evidence. Standalone user-note source-version gaps are explicit. Performed-Methods drafts/scaffolds exclude proposals and preferences.

Implementation: IO-free `web/src/lib/next-experiments.ts`, shared lead/child input `server/pi-packages/kady-notebook/next-experiments-schema.ts`, backend `agent/next-experiment-context.ts`, `next-experiments.ts`, `next-experiment-receipts.ts`, routes in `api/next-experiments.ts`, UI `next-experiments-dialog.tsx` / `next-experiment-cards.tsx`.

Routes are project-scoped under `/sessions/:sessionId/notebook/:entryId/next-experiments`: `GET /`, `POST /generate`, `POST /decision`, and read-only `GET /requests/:requestId`. Generation requires `approveModelCall`, a UUID and the reviewed context digest; preferences require exact proposal/context digests and a reason. Explicit invalid project scopes never fall back to default.
