# Notebook robustness workflows

**Stress-test finding** runs a reviewed set of Python sensitivity analyses for
a saved, active hypothesis with a [frozen analysis plan](lab-notebook.md#frozen-analysis-plans-and-deviations).
It uses [Modal compute](modal-compute.md).

## Review and run

1. Supply a Python script, explicit input files (including frozen-plan datasets and imported helpers), common metric/unit/null, resource, timeout, exact package pins and **2–16 specifications**. Each specification needs a key, label, rationale, seed and JSON parameters.
2. **Prepare snapshot and quote** copies/hashes the inputs locally and displays the exact script, specifications and total estimated sandbox commitment. It does not execute code or contact a model/compute service.
3. Review and approve the script/specifications, remote upload/execution and estimated commitment. The maximum you enter must cover the whole quote. Unverified frozen-plan data requires a separate acknowledgement.
4. Inspect every attempt and its logs. The notebook receives compute records linked as context; failures, cancellations, missing/malformed outputs and QC exclusions remain visible.
5. Export workflow JSON or Markdown. **Cancel remaining jobs** stops pending work; another attempt requires **New reviewed workflow**, with a new snapshot, quote and approval.

The plot/range/median uses successful, valid **QC-pass** outputs on the matching
metric/unit scale. It is descriptive sensitivity analysis, not significance
voting or independent replication. The script remains responsible for the
estimand, methods, random states and honest failure reporting.

## Python contract

The script runs in `/workspace` with the original relative input layout:

```text
python3 <script.py> --spec <spec.json> --output <result.json>
```

Input specification:

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

Required result shape (example values):

```json
{
  "schemaVersion": 1,
  "metric": "adjusted difference",
  "unit": "score units",
  "estimate": -0.42,
  "interval": { "low": -0.61, "high": -0.23, "level": 0.95 },
  "sampleSize": 100,
  "qc": "pass",
  "notes": "Discovery cohort only."
}
```

`estimate` must be finite for `pass`/`warn`; `fail` may omit it. Interval,
sample size and notes are optional. Invalid/mismatched values and failed commands
never enter the summary. Only this JSON output is collected. Declare all helper
files/dependencies; `PYTHONHASHSEED` is set, but library random states are your
script's responsibility. Approval does not bound arbitrary external side effects
or spending hidden inside code.

## Bounds

| Item | Limit |
|---|---|
| Specifications | 2–16; parameters ≤8,000 characters and 8 nesting levels |
| Runtime/resource | 1–3,600 seconds each; one catalogue preset, at most one GPU, no fallback |
| Environment | `python:3.13-slim`, ≤32 exact `package==version` pins; no shared cache or named environment |
| Inputs | ≤32 explicit files plus script; no directories/globs or hidden/escaping paths |
| Snapshot | 128 MiB/file, 256 MiB/workflow |
| Main script/result | UTF-8 script ≤128 KiB; result JSON ≤64 KiB |
| Retention | 1 GiB and 100 workflow directories per project |
| Preview | Expires in 15 minutes |

## Admission and recovery

All job records and reservations are committed before any job starts. Changed
source/plan/input bytes, expired previews or changed pricing require a new
review. Repeating approval of the same preview does not create another batch.
The workers upload and verify the approved private snapshot.

Recovery reconnects admitted work. Uncertain launches are not automatically
re-executed; missing/corrupt committed job records stay unverified with protected
holds. Unconfirmed creation/cleanup uses the full approved estimate. Inspect
remote state and recover original records before resolving uncertain holds.
These are single-backend safeguards, not distributed exactly-once execution or
provider invoice caps.

## Storage and implementation

Reviewed snapshots live under `.kady/notebook/robustness/<workflowId>/`;
admission records under `.kady/modal/approved-batches/<workflowId>/`. Visible
results land in `robustness-results/<workflowId>/`, but summaries read the
retained, checksummed Modal staging copy. Approved snapshots are not automatically
removed, and exports are not standalone environment/data reproductions.

See [`notebook-robustness.ts`](../server/src/agent/notebook-robustness.ts),
[`robustness-store.ts`](../server/src/agent/robustness-store.ts) and the
[shared protocol](../web/src/lib/notebook-robustness.ts). Project-scoped routes
are under `/sessions/:sessionId/notebook/:entryId/robustness`.
