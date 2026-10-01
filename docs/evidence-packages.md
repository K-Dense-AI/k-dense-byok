# Reviewer evidence packages

**Evidence package** prepares a frozen local ZIP containing selected notebook
records, linked evidence, provenance, plans, results and version-matched artifacts.
It makes no model/compute call and never executes captured analyses.

## Prepare and download

1. Select **Evidence package** in the notebook header or on a saved hypothesis, observation or decision. Choose **1–8 roots**; use All chats for cross-chat roots.
2. Choose artifact inclusion. Optional current/unverified copies are labelled comparison material. Raw command arguments are excluded by default.
3. **Prepare review package**, then inspect the roots, version table, missing-information report and checksum inventory.
4. Review sensitive content/redistribution rights and acknowledge the limitations before **Download reviewed ZIP**.

The downloaded archive is checked against its reviewed SHA-256, including in the
browser (localhost or HTTPS required). Later project changes do not alter it.
Excluding command arguments does not redact notebook prose, scripts or data files.

## Contents

The ZIP includes:

- Original selected notebook records, annotations and evidence relationships.
- Validated plans/deviations, saved result cards, related robustness definitions and all attempts.
- Recorded provenance and stored environment snapshots, without new environment probes.
- A deterministic, source-linked `methods-source.md`, `manifest.json` and `missing-information.md`.
- Selected artifact bytes, `checksums.sha256`, an optional `verify.py` checker and base RO-Crate 1.1 metadata.

The Methods scaffold preserves recorded claims and gaps; it needs author review.
Unrelated transcripts, auth stores and sandbox directories are not swept in.
Active compute is flagged and later outputs are not added to the frozen package.

## Artifact versions

| Status | Meaning |
|---|---|
| `included-matched` | Bytes match a recorded identity; the manifest names its basis. |
| `included-current-unverified` | Explicitly included current comparison copy, not the original cited version. |
| `unavailable` | The requested version could not be recovered or checked within limits. |
| `excluded` | Omitted by user choice, path safety or resource bounds. |

For recorded hashes, preparation checks retained package snapshots, relevant
Modal outputs/robustness inputs, then current files. Every candidate must match.
Hashes cannot recover overwritten bytes that were never retained. Multiple
versions of a path can coexist; identical bytes are deduplicated. Changed pinned
result cards are not substituted as original evidence.

## Integrity and limits

After extraction, optionally run `python3 -I verify.py`. It checks inventory,
paths and hashes without executing analysis files. Matching hashes are not
signatures, independent author authentication or scientific verification.
RO-Crate metadata describes the package; it does not promise workflow replay
or grant redistribution rights.

| Resource | Bound |
|---|---|
| Evidence closure | 64 records, 3 relationship hops |
| Artifact lineage | 128 versioned references, 8 upstream hops, 200 steps |
| Individual artifact | 128 MiB |
| Package payload | 256 MiB / 512 files, including metadata |
| Retained versions | 1 GiB/project |
| Saved packages | 20 packages / 2 GiB ZIP-plus-metadata budget |

Source discovery and reads also have budgets; omissions and degraded provenance
remain explicit. Environment snapshots do not prove every package, seed or
hardware detail. Storage assumes one backend and filesystem hard-link support.

## Storage controls

Packages live under `.kady/evidence/packages/<id>/`; retained versions live in
`.kady/evidence/blobs/<sha256>`.

- **Remove package** deletes only that ZIP/payload, leaving original research files and shared snapshots.
- **Prune unreferenced snapshots** removes versions no retained package uses. Old notebook citations may become unrecoverable; corrupt references block pruning.

Preparation does not publish or share anything. Local files remain within the
[same-user trust boundary](limitations.md#local-shell-trust-boundary).

Implementation: [`server/src/evidence/`](../server/src/evidence/). Routes under
`/projects/:projectId/notebook/evidence-packages` support prepare, list, inspect,
reviewed download, removal and snapshot pruning; there is no execution endpoint.
