# Modal compute

Kady runs remote CPU/GPU commands through a project-owned job service. The
backend-host sandbox remains canonical; jobs, logs and outputs appear in the
center-panel **Compute** tab.

## Configure and use

Save a Modal token ID/secret pair in **Settings → Services**. Kady validates it;
existing chats pick up changes live. Credentials remain on the backend host and
are not copied into remote sandboxes.

Choose a resource beside the composer. The backend
[catalogue](../server/src/modal/catalog.ts) supplies CPU, single-GPU and multi-GPU
presets and estimated rates. A tool call can request another supported preset.
Custom images require Python 3.8+ with its standard library, `sh` and `mv`;
incompatible images fail before upload with `RUNTIME_UNAVAILABLE`.

| Tool | Behavior |
|---|---|
| `modal_run` | Submit and wait; stopping the chat cancels this blocking job. |
| `modal_submit` | Start durable background work and return its ID. |
| `modal_status` / `modal_wait` | Read state/logs or wait for a bounded period; wait timeout 0 reads once. |
| `modal_cancel` | Explicitly cancel a job. |
| `modal_results` | Collect/report outputs. |
| `modal_submit_batch` | Submit a bounded group of independent jobs. |

Lead and specialist agents use the same service. Background jobs survive their
chat turn until completion, cancellation, timeout or project deletion. The
Compute tab exposes logs, manifests, estimated costs, errors and job controls.

## Lifecycle and recovery

Jobs normally move through `queued → preparing → running → collecting → succeeded`,
or terminate as failed/cancelled/lost. State and bounded logs persist under
`.kady/modal/jobs/<jobId>/`.

After a backend restart, the manager reconnects using saved sandbox IDs, resumes
monitoring/collection and cleans up tagged orphan or surviving terminal
sandboxes. Missing remote sandboxes become visible lost jobs. Failed cleanup
remains pending and is retried, including after credentials return. Log gaps
are recorded if remote output rolls out of the retained window.

## Files and cache

- Inputs must be inside the project sandbox. Directories recurse; missing inputs, escaping symlinks and oversized transfers fail validation.
- `.kady`, `.pi` and job-control paths are reserved in both directions, including through aliases.
- Input bytes are hashed at execution and checked remotely before the command. Outputs are checked before and after download; checksum/truncation failures are explicit.
- Outputs are staged and verified before atomic per-file replacement. Installation rechecks the current raw-data guard; protected targets such as `user_data/**` are refused.
- Verified output copies remain in the job's staging directory for provenance, robustness and evidence packaging. Do not manually prune this evidence.

Optional project Volumes cache dependencies/models/reference data. Named
environments reuse images; neither replaces the project workspace. **Settings →
Services → Remote cache** clears cache without touching local research files.

## Budgets and reservations

Before admission, Kady reserves the most expensive fallback resource's estimated
rate over the command timeout plus transfer headroom. Headroom is 10% of the
timeout, bounded to 1–15 minutes; the command still gets only its requested timeout.
CPU/RAM are counted once per sandbox; GPU cost scales with GPU count.

Admission checks **spent + reserved + new reservation** against the project cap.
On termination, confirmed cleanup settles estimated elapsed resource cost and
releases unused holds. Uncertain creation/cleanup conservatively counts the full
reservation; later cleanup does not invent an exact earlier stop time. The UI
shows spent, reserved and their sum, committed.

These are estimates, not invoice reconciliation. Image builds, cache storage,
egress and provider adjustments are outside them. Model calls admitted
concurrently can also exceed the remaining project cap.

## Reviewed robustness batches

Notebook **Stress-test finding** uses a separate reviewed snapshot/approval path,
reserving every specification before any remote work starts. Generic batch
submission does not provide that contract, and managed jobs cannot be directly
retried. See [Robustness workflows](notebook-robustness.md).

## Boundaries and verification

Multi-GPU runs use one sandbox; there is no multi-node training orchestration,
fine-grained per-job egress policy or secret injection. Finished records and
verified outputs have no automatic retention cleanup. Only resource-availability
errors move jobs through a fallback chain.

Backend tests normally use fake adapters. With `MODAL_TOKEN_ID` and
`MODAL_TOKEN_SECRET` exported in the test shell, the opt-in live test creates a short CPU job, verifies transfers/accounting and
cleans up:

```bash
cd server
MODAL_LIVE_TEST=1 npm test -- test/modal-live.test.ts
```

Implementation: [`server/src/modal/`](../server/src/modal/) and
[`modal-tool.ts`](../server/src/agent/modal-tool.ts).
