# Notebook robustness workflows

Use **Stress-test finding** on a saved, active hypothesis to run a reviewed set of
scientific sensitivity analyses. This is Stage 3 of the [notebook roadmap](./notebook-roadmap.md).
It uses the existing durable Modal manager, not a separate compute service.

## Scientist workflow

1. **Freeze a local analysis plan** with the hypothesis's Analysis plan control.
2. **Prepare a recipe.** Supply an existing UTF-8 Python script, explicit input
   files (including every frozen-plan dataset and imported helper), a common
   metric/unit/reference null, a Modal resource, timeout, exact PyPI package pins,
   and 2–16 specifications. Each specification has a unique key, label, scientific
   rationale, integer seed and JSON parameter object. Kady can propose this via
   `notebook.robustness`, but a proposal does not submit jobs.
3. **Prepare snapshot and quote.** This performs bounded local file IO only, not
   a model call, Python execution, dependency installation or remote submission.
   The server copies and hashes the exact input bytes into a private snapshot,
   displays the script, all specifications and input identities, and quotes the
   sum of every job's estimated sandbox cost over its full lifetime (the command
   timeout plus the transfer headroom described in
   [Durable Modal compute](./modal-compute.md#budgets-and-reservations)). A
   quote prepared before that rule existed no longer matches; approving it fails
   with `PRICE_CHANGED` and the workflow must be prepared again.
4. **Review and approve.** Separate confirmations cover the exact script and
   specifications, uploading/executing those files on Modal, and the estimated
   commitment. The entered maximum must cover the entire quote. If a dataset was
   unverified when the original plan was frozen, a separate acknowledgement is
   required: the new snapshot does not retroactively verify that original plan.
5. **Watch every attempt.** The dialog polls active work, and the notebook receives
   server-authored `compute` notes/observations for authorization and terminal
   attempts. Admission failures, nonzero exits, missing/malformed outputs,
   QC failures, cancellations and lost jobs remain visible. These system entries
   link to the hypothesis as **context**, never as an automatic scientific verdict.
6. **Inspect or export.** The effect/interval plot and range/median use comparable,
   successful, valid QC-pass outputs. QC-warn/fail results are retained but excluded
   from the descriptive summary. Missing intervals and sample sizes are explicit.
   Download workflow JSON (the full reviewed definition and recorded results, not a standalone dataset/environment bundle) or a human-readable Markdown summary. Normal
   notebook Markdown/JSON/ZIP/print exports preserve the generated authorization
   and attempt entries (including the approved specification definitions).

**No significance vote.** These are author-selected sensitivity checks, not an
exhaustive multiverse, independent replications, probabilities of truth, or
independently verified scientific results. The script controls the estimand,
method, use of seeds and QC. Matching metric/unit labels prevent accidental mixing
of labelled scales but do not verify the mathematics. A script must not invent an
estimate when a model cannot be fitted; a QC-fail result may omit its estimate.

## Python contract

The script runs from `/workspace` against the original relative file layout:

```text
python3 <script.py> --spec <server-generated-spec.json> --output <unique-result.json>
```

The specification JSON contains:

```json
{
  "schemaVersion": 1,
  "key": "site_adjusted",
  "seed": 42,
  "metric": "adjusted difference",
  "unit": "score units",
  "nullValue": 0,
  "parameters": { "adjust_for_site": true }
}
```

Write one result JSON file:

```json
{
  "schemaVersion": 1,
  "metric": "adjusted difference",
  "unit": "score units",
  "estimate": -0.42,
  "interval": { "low": -0.61, "high": -0.23, "level": 0.95 },
  "sampleSize": 100,
  "qc": "pass",
  "notes": "Discovery cohort only; no independent validation."
}
```

`estimate` must be finite for `pass`/`warn`; it may be omitted for `qc: "fail"`.
Intervals, sample size and notes are optional. Invalid JSON, mismatched metric or
unit, invalid intervals and non-finite numbers are not converted into estimates.
A failed command's output can still be inspected, but never enters the summary.

A minimal **illustrative** implementation (not a validated domain analysis) uses
only the standard library. For a CSV with a `value` column, it demonstrates
seeded percentile bootstrap intervals; variations can change the Monte Carlo
sample count to inspect numerical stability, not independent replication:

```python
import argparse
import csv
import json
import math
import random
import statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--spec", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.spec).read_text())
with open("data.csv", newline="") as handle:
    values = [float(row["value"]) for row in csv.DictReader(handle)]
result = {"schemaVersion": 1, "metric": spec["metric"], "unit": spec["unit"]}
if len(values) < 2 or not all(math.isfinite(v) for v in values):
    result.update(qc="fail", notes="Insufficient or non-finite data; no estimate.")
else:
    rng = random.Random(spec["seed"])
    count = int(spec["parameters"].get("bootstrap_samples", 1000))
    if not 100 <= count <= 10000:
        raise ValueError("bootstrap_samples must be 100–10000")
    means = sorted(statistics.mean(rng.choices(values, k=len(values)))
                   for _ in range(count))
    result.update(
        qc="pass", estimate=statistics.mean(values), sampleSize=len(values),
        interval={"low": means[int(.025 * (count - 1))],
                  "high": means[int(.975 * (count - 1))], "level": .95},
        notes="Illustrative percentile bootstrap; assess domain assumptions separately.",
    )
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
Path(args.output).write_text(json.dumps(result, allow_nan=False))
```

Set the common metric/unit appropriately for the real data. Declare every local
helper/config file and package dependency. `PYTHONHASHSEED` is set automatically;
other libraries' random states remain the script's responsibility. Do not hide
credential access, additional remote job spawning, network-sourced datasets or
runtime package installation inside a recipe. Approval bounds the scheduled
sandboxes, **not arbitrary external side effects or spending performed by code**.

## Budget and lifecycle guarantees

- Quote: sum of catalogue hourly estimate × maximum lifetime for every
  specification. All reservations and job records are created **before** a shared
  admission marker permits remote work. If admission fails, none of the partial
  batch is scheduled, its holds are released/reconciled, and every specification
  remains in the record as cancelled/not admitted as appropriate.
- The project spend cap is checked at admission, not just at preview. A stale
  source/plan, changed original/snapshot bytes, conflicting output namespace,
  increased resource price or expired preview requires another review.
- Reviewed private snapshots—not later edits to the original files—are uploaded.
  Workers verify snapshot hashes before creating a sandbox and verify the actual
  uploaded bytes with isolated Python before invoking the analysis.
- Preview/approval ids and job ids are stable; repeated approval of the same
  preview does not create a second batch. Authorizations and admission digests
  bind the project; copying them into another project does not authorize work.
- Startup and credential-restoration recovery complete interrupted admissions and
  reattach durable jobs. Jobs without a committed admission marker are held.
  A job left preparing without a saved remote id is treated as an **uncertain
  launch**, not automatically executed again.
- Cancellation is persisted before cancelling remaining managed jobs. Completed
  results are not rewritten. Direct retry of a managed job is refused; **New
  reviewed workflow** creates a new snapshot, quote, approval and attempt set.
- Unknown remote creation or cleanup conservatively counts the full approved
  sandbox estimate against the project budget. This is not a statement that Modal
  actually charged that amount. If a committed job record is missing/corrupt, it
  is shown as unverified, is not recreated, and its budget hold remains protected.
  Inspect Modal and recover the original records before reconciling such an
  uncertainty; do not blindly clear holds or restore stale queued-job backups.

These are **estimated sandbox commitments, not Modal invoice caps**. Image builds,
storage, transfer, pricing changes and other provider charges can differ. The
standard manager remains the sole ledger/reservation owner; the notebook adds no
second cost ledger. Normal standalone Modal tools retain their existing semantics.

## Bounds and current limitations

| Boundary | Limit / behaviour |
|---|---|
| Specifications | 2–16, explicit and reviewed before execution |
| Parameters | JSON objects, ≤8,000 characters each, ≤8 nesting levels |
| Runtime | 1–3,600 seconds per specification |
| Resource | One catalogue preset; at most one GPU; no fallback |
| Environment | `python:3.13-slim` plus ≤32 exact `package==version` pins; no named environment or shared project cache |
| Input selection | ≤32 explicit files plus the script; no directories/globs, hidden files or symlink escapes |
| Input snapshot | ≤128 MiB/file, ≤256 MiB/workflow; bounded async copying/hashing |
| Main script | Valid UTF-8, ≤128 KiB; factor larger code into declared helpers |
| Retained inputs | ≤1 GiB/project and ≤100 workflow directories; approved evidence is never automatically removed |
| Preview | 15-minute expiry; ≤512 KiB review record; expired unapproved previews can be cleaned up |
| Collected result | One JSON file, ≤64 KiB; other files are not downloaded by this workflow |
| Scientific summary | Finite, matching-scale, successful QC-pass outputs only; all exclusions stay visible |

The image recipe is **not** a bit-for-bit image/package-environment guarantee.
Arbitrary code is not independently audited. This version is Python-only, uses a
single backend as the Modal owner, and is not a distributed exactly-once system.
Local records/snapshots are not a same-user shell security boundary or external
preregistration. Approved snapshots are retained, so users must account for their
local storage footprint; reviewer packaging and version-vault pruning are handled
by [evidence packages](./evidence-packages.md).

## Storage and API

```text
.kady/notebook/robustness/<workflowId>/
  preview.json                 # immutable recipe, source/plan identity, quote, hashes
  approval.json                # explicit local approval of that preview digest
  admission-error.json         # when complete admission failed
  inputs/                      # private, reviewed source/config byte snapshots
.kady/modal/approved-batches/<workflowId>/
  intent.json                  # protected reservation/job identities
  committed.json               # all jobs/holds ready; permits execution
  cancelled.json               # durable cancellation intent
robustness-results/<workflowId>/<specKey>/result.json
```

Modal owns its normal `.kady/modal/jobs/<jobId>/` state, logs, staging and compute
provenance. The notebook reads metrics from the **retained transfer staging copy**
and verifies its recorded output hash, not from a mutable current output file.
Generated notebook artifact references retain the server-recorded output identity,
so later edits to the visible JSON produce review warnings.

Under `/sessions/:sessionId/notebook/:entryId/robustness`:

- `GET /` — approved workflow history, read errors and configuration state.
- `POST /preview` — `{draft, planId, expectedPlanHead}`; no remote work.
- `POST /:workflowId/approve` — exact `digest`, `approveRemote`, `reviewedScript`,
  `acknowledgeEstimates`, `maxEstimatedUsd`, and (when required)
  `acknowledgeUnverifiedPlanData`.
- `GET /:workflowId` — full workflow, all attempts and validated retained results.
- `POST /:workflowId/cancel` — cancel remaining managed jobs, preserving history.

Explicit missing project headers are refused rather than falling back to another
project. Logs and detailed job provenance remain accessible through the Compute
view and existing Modal APIs.
