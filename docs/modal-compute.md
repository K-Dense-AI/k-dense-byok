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
- `modal_wait` waits for a bounded period for a job to finish; `timeout_sec: 0`
  is a single read of the current state.
- `modal_cancel` cancels a job explicitly.
- `modal_results` collects or reports a completed job's outputs.
- `modal_submit_batch` submits a bounded group of independent jobs.

Background jobs intentionally survive the chat turn that created them. They
continue until completion, explicit cancellation, timeout, or project deletion.

## Notebook robustness batches

The notebook's **Stress-test finding** control adds a separately reviewed workflow
on top of this manager: exact private input snapshots, 2–16 specifications, explicit
remote-upload approval and a full-batch cost quote. These managed batches reserve
all jobs before any is scheduled and have no automatic fallback or direct retry.
Do not substitute ordinary `modal_submit_batch` for this approval-aware admission
path. Uncertain launches/cleanup use a conservative full-reservation estimate,
and missing committed job records retain their holds pending recovery. See
[Notebook robustness workflows](./notebook-robustness.md) for the Python contract,
limits and the distinction between estimated sandbox commitments and invoices.

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

Recovery also cleans up what a crash can leave behind:

- a job interrupted between Modal creating its sandbox and K-Dense saving the
  id is found again through the job-id tag, and that sandbox is terminated
  before the job is re-run (it never received the command wrapper, so it
  cannot be resumed);
- a terminal job whose sandbox termination was never confirmed has it
  terminated on the next start, and a fallback sandbox whose termination
  failed is retried until it succeeds;
- cancelling a job while Modal credentials are missing marks it cancelled and
  releases its hold immediately; the sandbox itself is terminated as soon as
  credentials are configured again.

Logs are synchronised by logical byte offset: the wrapper publishes how many
bytes it has trimmed from each bounded log, so K-Dense appends exactly the
unseen bytes without scanning for overlaps, and a `log_gap` event records any
bytes that rolled out of the remote window before they could be retained.

## Files and outputs

Inputs are validated before a remote sandbox is created:

- paths must remain inside the project sandbox;
- missing inputs fail immediately;
- directories are enumerated recursively;
- escaping symlinks and excessive transfer sizes are rejected;
- `.kady`, `.pi` and the job control directory are reserved and never
  transferred in either direction.

Input bytes are hashed when the job starts (streamed, so a large input set does
not stall the app), uploaded, and then re-hashed inside the sandbox; a mismatch
fails the job with `INPUT_CHANGED` before the command runs. Outputs are hashed
inside the sandbox before download and re-hashed after it (`CHECKSUM_MISMATCH`
on a difference, `TRANSFER_TRUNCATED` on a short download). An image without
`python3` cannot run these remote checks; ordinary jobs then fall back to size
checks and record a `verify_skipped` event, while approved robustness jobs fail
instead.

Output discovery only looks where a pattern can match: a literal path is
checked directly and a glob walks its literal prefix directory, so a virtual
environment created in the workspace does not exhaust the discovery budget.
Remote outputs are downloaded into a local temporary directory, verified, copied
next to their targets and then renamed into place, so a failed download leaves
the previous files untouched; a target that is an existing directory aborts the
install before anything lands. The verified copy under the job's `staging/`
directory is retained as the record of what the compute produced (evidence
packages and robustness workflows read it). Output patterns are bounded, and job
details distinguish missing files from transfer, permission, size, and other
I/O errors.

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
estimated hourly rate × (requested timeout + transfer headroom)
```

The transfer headroom is 10 % of the timeout, at least one minute and at most
fifteen; it is the extra sandbox lifetime kept for staging inputs and collecting
outputs, so a command that uses its whole timeout still gets its outputs back.
The command itself is limited to exactly the requested timeout. Admission is
blocked when settled project spend plus open reservations plus the new
reservation would exceed the hard project cap. On every terminal path—success,
non-zero exit, failure, cancellation, timeout, or recovery loss—the reservation
is settled to estimated elapsed spend and unused headroom is released.

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
- Provider errors are classified (`AUTH_FAILED`, `IMAGE_BUILD_FAILED`,
  `TIMEOUT`, ...) with an honest retry flag; only resource availability moves a
  job to the next instance in its fallback chain.
- Finished jobs keep their records, bounded logs and the verified output copy
  indefinitely; there is no automatic retention policy yet.

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

