# Reviewer evidence packages

**Evidence package** creates a local, frozen research-object ZIP for reviewer
inspection. It is Stage 5 of the [notebook roadmap](./notebook-roadmap.md), distinct
from the existing lightweight notebook ZIP export.

**Packaging is not reproduction or scientific validation.** Preparation does not
execute captured code, probe Python/R environments, call a model, install
packages, rerun a workflow or submit remote compute. No prior approval is reused
as permission to execute anything.

## Use it

- In the Lab Notebook header, select **Evidence package** and choose 1–8 roots
  from the visible notebook scope. Choose **All chats** first for cross-chat roots.
- A saved hypothesis, observation or decision also has an **Evidence package**
  control preselected to that record.
- Supporting/challenging links and amendments are followed in both directions
  within bounded limits. Superseded records are not silently dropped and absent
  or out-of-bound references remain explicit.
- Choose whether to include artifact bytes. By default, current files without a
  trustworthy historical identity are **not** substituted for original evidence.
  An optional comparison-copy setting includes them only as current/unverified.
- Raw provenance arguments are excluded by default because commands can contain
  sensitive parameters. This does **not** redact notebook prose, snippets,
  workflow definitions or file contents.
- **Prepare review package** creates local snapshots and a frozen ZIP. Inspect
  the included roots, artifact-version table, missing-information list and
  checksum inventory. Acknowledge sensitive-data/rights review and the stated
  limitations before **Download reviewed ZIP**.

The browser checks the actual downloaded ZIP against the reviewed SHA-256 before
saving it (localhost or HTTPS is required for browser cryptography). The backend
also verifies the retained archive, and streams checksummed payloads rather than
regenerating a different package at download time. Later project changes are not
silently folded into an already prepared package.

## Contents

```text
README.md
manifest.json                  # roots, source ids/digests, relationships, artifact versions
missing-information.md         # explicit gaps, qualifications and bounds
methods-source.md              # deterministic, source-linked Methods scaffold
ro-crate-metadata.json         # base RO-Crate 1.1 descriptor and file inventory
checksums.sha256
verify.py                      # optional static integrity checker, never auto-run
records/<record-key>.json       # captured original notebook JSONL records
metadata/evidence.json
metadata/annotations.json       # selected records' user comments/pins
metadata/provenance.json        # selected observed steps and version-aware input links
metadata/plans/*.json           # validated frozen-plan revisions and deviations
metadata/results/*.json         # bounded canonical scientific-result resolutions
metadata/workflows/*.json       # related reviewed robustness definitions/all attempts
metadata/environments/*.json    # stored environment snapshots, never newly probed
artifacts/<sha256>.<extension>  # regular files, version-addressed rather than path-overwritten
```

Original notebook rows are preserved as JSON, with source digests defined over
original JSONL rows excluding LF. The source-record file's own archive checksum
is listed separately. Author roles and scientific claims are recorded labels,
not externally authenticated identities or verified findings.

The Methods scaffold quotes recorded narrative/snippets, links each quoted block
to its source, and points to observed tool steps, plan/deviation histories and
structured results. It does not transform intentions into performed procedures
or invent missing versions, thresholds, seeds or sample sizes. It requires author
editing/review before use as manuscript text. Existing AI Methods drafts are not
automatically included or treated as verified source-linked text.

Pins/comments attached to selected records are included as editable user
annotations. Unrelated standalone notes, raw chat transcripts, auth stores and
unrelated sandbox directories are not swept into the archive.

## Artifact version policy

Every requested artifact version has a manifest row. Different versions of the
same path can coexist in one package; identical bytes are de-duplicated.

- **included-matched**: captured bytes match a recorded hash. The **identity
  basis** says what was matched: a notebook citation, server-recorded output,
  consumed input or frozen-plan dataset. This is byte identity, not proof that
  the scientific interpretation or inferred producer is correct.
- **included-current-unverified**: an explicitly allowed export-time comparison
  copy. It is not the original cited/consumed version. Retrospectively measured
  hashes do not become citation-time proof.
- **unavailable**: the requested historical hash could not be recovered, or a
  required read/check exceeded a limit. The failure reason remains visible.
- **excluded**: excluded by user policy, path safety or resource bounds.

For a known historical identity, preparation first checks the project's retained
content-addressed snapshots, then relevant retained Modal outputs/robustness
inputs, then current sandbox bytes. All candidates must match the expected hash.
If nothing matches, the original is marked unavailable. The optional current-copy
setting never relabels a replacement as matching historical evidence.

This is **selective retention**, not time travel: versions overwritten before any
retention mechanism captured them cannot be recovered from hashes alone. Once a
package captures a version, later packages can recover it from the local vault
while it remains retained. Corrupt retained copies are not silently overwritten
or presented as verified.

## Provenance and incomplete evidence

Upstream traversal is version/time-aware: for each version it selects matching
recorded outputs at or before use, then follows the recorded inputs. Where a
citation has no hash, a producer selected by time is explicitly only a candidate.
Observed, inferred, declared, retrospective and degraded distinctions survive in
the JSON and missing-information report. Missing origins, unresolved evidence,
truncated edges, scan limits and absent environments never become verified
absence.

Stored environment records are identity-checked and copied without executing
capture probes. Matching recorded root lockfiles can be included; this does not
create an installable environment or prove every package/hardware/seed used.
Remote image recipes are not exact image/package inventories. Opaque shell calls
are observations of effects, not complete IO traces.

Canonical `scientific_result` cards are included as matched originals only when
the persisted content matches the notebook's pinned identity. Changed cards are
not silently substituted. Unpinned/unverified card content follows the explicit
current-unverified policy. Artifact paths inside a card do not themselves establish
citation-time file identity.

Robustness metadata preserves failures and excluded estimates as well as successes.
Active/unsettled compute at capture is flagged; subsequent outputs are not added
later to the frozen ZIP. External citations, scientific validity and redistribution
rights are not automatically checked.

## Integrity and interoperability

After extraction, optionally run:

```bash
python3 -I verify.py
```

The static checker requires isolated Python, checks the file inventory and hashes,
and rejects unsafe paths, unexpected files and mismatches. It does not import or
execute captured analysis files. Code is stored in the ZIP with non-executable
permissions. Do not execute untrusted artifacts just because their hashes match.

The archive includes **base RO-Crate 1.1** JSON-LD metadata with the required root
Dataset/descriptor fields and a file inventory. The usage/rights statement grants
no license. The assembly timestamp is local package creation, not external
publication. No Workflow Run/Provenance Run Crate conformance or complete execution
replay is asserted. JSON-LD processors may need the public RO-Crate context;
preparation itself makes no network request for it.

Reference: [RO-Crate 1.1 root data entity](https://www.researchobject.org/ro-crate/specification/1.1/root-data-entity.html).

Checksums are not signatures: someone can replace both data and checksums. Compare
the ZIP hash with the value shown by Kady before trusting a received copy. These
local records are not a same-user shell security boundary or independent
preregistration. Use the isolation guidance in [limitations](./limitations.md) for
adversarial content.

## Storage and bounds

Evidence storage is project-local:

```text
.kady/evidence/blobs/<sha256>      # version vault, regular byte snapshots
.kady/evidence/packages/<id>/
  payload/                       # source/metadata files and links to retained versions
  evidence.zip                   # frozen archive
  preview.json                   # project-bound review manifest and ZIP digest
```

| Resource | Bound |
|---|---|
| Selected roots | 1–8 saved notebook entries |
| Evidence closure | 64 records, 3 relationship hops, 512 serialized edges |
| Notebook discovery | Existing bounded research-memory scan (warnings preserved) |
| Artifact/input walk | 128 versioned references, 8 upstream hops, 200 selected steps |
| Provenance discovery | 100 sessions, 32 MiB, 10,000 rows; omissions explicit |
| Supporting metadata | 16 MiB shared read budget; up to 32 environment snapshots and 16 related robustness workflows |
| Scientific-result discovery | 32 references and 64 MiB of bounded source-log reads |
| Artifact | 128 MiB per file |
| Package payload | 256 MiB / 512 files, including metadata; space reserved for final manifests |
| Artifact candidate reads | 512 MiB total; failed candidate checks consume the budget too |
| Review manifest | 2 MiB maximum |
| Retained versions | 1 GiB per project |
| Saved packages | 20 packages / 2 GiB ZIP-plus-metadata budget |

Preparation/storage mutations are serialized within the backend; the existing
single-backend project ownership assumption remains. This is not a distributed
storage/transaction service. Normal APFS/ext4/NTFS hard-link support is required
for exclusive publication and retained payload links; unsafe fallback overwrites
are not used.

**Saved packages / storage** separates two actions:

- **Remove package** deletes that frozen ZIP/payload only, not original research
  files. Shared historical snapshots remain available.
- **Prune unreferenced snapshots** requires explicit acknowledgement. It removes
  versions no longer referenced by retained packages; old notebook citations may
  then become unrecoverable. Corrupt package references block pruning rather than
  being guessed away.

Approved/source records are not rewritten. Originals are never deleted by these
controls. Unfinished/corrupt packages remain visible/removable. Packages are local
until the user downloads/shares them; preparation itself does not publish anything
or add a model/compute charge.

## API

Under `/projects/:projectId/notebook/evidence-packages`:

- `POST /prepare`: `{title, roots: [{sessionId, entryId}], includeArtifacts,
  includeCurrentUnverified, includeCommandArguments}`.
- `GET /`: saved packages, errors and storage status.
- `GET /:id`: the frozen review manifest.
- `POST /:id/download`: `{digest, acknowledgeSensitive: true,
  acknowledgeLimitations: true}`; verified ZIP with SHA-256/ETag headers.
- `DELETE /:id`: remove only that package.
- `POST /prune-snapshots`: `{confirmed: true}`; explicitly prune unreferenced
  retained versions.

Requests must match the active project. Copied packages do not become another
project's authorization. There is no execution/reproduce endpoint and no
agent-facing tool that marks these packages as verified science.
