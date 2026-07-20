# Durable Modal compute

K-Dense BYOK can offload expensive commands to isolated
[Modal](https://modal.com) CPU and GPU sandboxes while the local project
sandbox remains the source of truth. Modal jobs are project-scoped, persisted
on disk, metered against the project budget, and visible in the **Compute** tab.

## Configure Modal

Open **Settings → API keys** and save the Modal token ID and token secret as a
pair. K-Dense validates the pair before marking the connection ready. Existing
chat tabs pick up credential changes without a restart.

Modal credentials stay in the repo-root `.env` file on the local machine. They
authenticate K-Dense to Modal but are not copied into remote sandboxes.

## Pick compute

The compute picker reads its resource catalogue from the backend. It includes
CPU presets and single- or multi-GPU options, depending on what Modal makes
available to the account. The selected resource is the chat's default; a tool
call can request another supported resource when the task requires it.

Rates shown in K-Dense are estimates. Modal bills sandboxes by their requested
or actual resources and elapsed time, and does not expose a generally available
per-sandbox invoice API. The job detail therefore labels compute amounts as
estimated rather than exact.

## Agent tools

The lead agent and sub-agents share the same project job service:

- `modal_run` submits a short job and waits for it. Stopping the chat turn
  cancels this blocking job.
- `modal_submit` starts a durable background job and returns its job id.
- `modal_status` reads a job's current state and recent logs.
- `modal_wait` waits for a bounded period for a job to finish.
- `modal_cancel` cancels a job explicitly.
- `modal_results` collects or reports a completed job's outputs.
- `modal_submit_batch` submits a bounded group of independent jobs.

Background jobs intentionally survive the chat turn that created them. They
continue until completion, explicit cancellation, timeout, or project deletion.

## Job lifecycle and recovery

A job moves through these durable states:

```
queued → preparing → running → collecting → succeeded
                                      └──→ failed
queued/preparing/running/collecting ──→ cancelled
```

K-Dense writes job state, transitions, and bounded stdout/stderr logs under:

```
sandbox/.kady/modal/jobs/<jobId>/
```

Each remote sandbox is named and tagged with its K-Dense job id. If the backend
restarts, it scans non-terminal records, reconnects to surviving sandboxes, and
resumes monitoring or collection. A remote sandbox that can no longer be found
is marked `lost`, its budget reservation is reconciled, and the failure remains
visible in job history.

## Files and outputs

Inputs are validated before a remote sandbox is created:

- paths must remain inside the project sandbox;
- missing inputs fail immediately;
- directories are enumerated recursively;
- escaping symlinks and excessive transfer sizes are rejected;
- transferred files receive integrity checksums.

Remote outputs are downloaded into a local temporary directory and validated
before being installed atomically at their requested sandbox paths. Output
patterns are bounded, and job details distinguish missing files from transfer,
permission, size, and other I/O errors.

The local project remains canonical. Modal Volumes are used only for optional
per-project dependency, model, and reference-data caches. Named environment
snapshots can reuse an installed environment without turning the remote
filesystem into a second project workspace.

## Logs and job controls

The center-panel **Compute** tab shows all jobs for the project, including:

- lifecycle and current phase;
- requested and resolved resources;
- live stdout and stderr tails;
- elapsed time and estimated spent/reserved cost;
- input and output transfer manifests;
- failure details;
- cancel, retry, collect, and open-output actions.

Logs are persisted with a size cap so a noisy process cannot consume unlimited
local disk or model context. Tool results still contain a compact tail and link
back to the complete retained job record.

## Budgets and reservations

Before creating Modal resources, K-Dense reserves the job's worst-case estimate:

```
estimated hourly rate × requested timeout
```

Admission is blocked when settled project spend plus open reservations plus the
new reservation would exceed the hard project cap. On every terminal path—
success, non-zero exit, failure, cancellation, timeout, or recovery loss—the
reservation is settled to estimated elapsed spend and unused headroom is
released.

The cost UI distinguishes:

- **spent**: settled model and compute estimates;
- **reserved**: worst-case holds for active Modal jobs;
- **committed**: spent plus reserved.

Historical compute rows remain valid and require no migration.

## Current boundaries

- Multi-GPU jobs run within one Modal sandbox; multi-node distributed training
  is not orchestrated yet.
- Cost is an estimate, not reconciliation against Modal's final invoice.
- Network egress policy and per-job secret injection are separate security
  improvements.
- Transfer checksums protect integrity but are not a complete scientific
  provenance system.

## Developer verification

Normal backend tests use an injected fake Modal adapter and never contact the
service. With a configured token pair, run the opt-in real CPU smoke test with:

```bash
cd server
set -a; source ../.env; set +a
MODAL_LIVE_TEST=1 npm test -- test/modal-live.test.ts
```

The test creates a short CPU sandbox, transfers one input and output, verifies
the returned artifact, reconciles estimated cost, and then cleans up.

