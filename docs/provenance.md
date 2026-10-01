# Provenance

Open a file and select **Provenance** in its preview header to inspect recorded
producers, inputs, model/run identity, environment and notebook citations.
The server derives these records from tool events and file operations; the
agent has no provenance-authoring tool.

## Sources and confidence

| Source | What is recorded |
|---|---|
| Lead agent | Live tool events; direct file operations or a bounded sandbox scan around opaque calls. |
| Specialist | Child session tools harvested at completion, with the child's name and model. |
| User | Upload, editor save, move and delete operations through the sandbox API. |
| Modal | A terminal compute step using transfer-layer input/output hashes, including failed, cancelled and lost attempts. |

File edges distinguish **observed** effects, **inferred** attribution and
**declared** links. Direct `read`/`write`/`edit` calls name their files. Shell,
delegation, codemode and unknown tools need scan-based attribution; overlapping
calls can make that attribution inferred. Nested codemode tool calls also get
their own steps. Known read-only tools do not trigger a scan.

For opaque commands, file names in the command line can become inferred inputs
if they existed before the call and were not written. Hard-coded paths inside
scripts, globs and variable expansion are not a complete input trace.

## Lineage and freshness

Lineage follows the producing version at or before the consuming step. A figure
can therefore point to the table version it used even after that table changes.
**Changed since use** flags a mismatch against current bytes. The walk reports
uploads, user-created files, missing origins and truncation explicitly; it stops
at 60 nodes or 12 hops and keeps only one reached version per path.

| Status | Meaning |
|---|---|
| Current | Current bytes match a recorded write-time identity. |
| Stale | Current bytes differ from the recorded identity. |
| Unverified | Identity is missing, retrospective or could not be checked. |

Notebook citations predating a file's latest version are flagged. Hash equality
proves byte identity, not scientific validity or the ability to reproduce a run.

## Environment and remote work

Run-start snapshots record available Python/venv package metadata, R packages
through a bounded probe, root lockfile hashes, Git HEAD, OS and uv version.
Install-shaped commands or changed environment fingerprints trigger recapture.
A step retains the environment it started with; changes inside one command may
not be captured until afterward. Seeds and complete hardware state are not recorded.

Modal steps carry the remote command, resource, image/environment recipe and
transfer identities. They do not enumerate the remote image's installed packages.
Verified transfer staging supplies the output identity, including when the visible
sandbox file is later edited.

## Specialist caveats

Child files and environments are inspected **at harvest**, not during the write.
A matching harvest-time hash stays unverified at execution time. Child writes
use `wrote` rather than guessing created/modified. Opaque child calls have no
scan baseline; optional time-window attribution is inferred and may overlap
other work. A separate lead scan can provide stronger evidence when it actually
observed the write. Nested specialists (depth greater than one) are not harvested.

## Coverage limits

| Bound | Visible result |
|---|---|
| 20,000 scanned files | `sandbox-too-large` |
| Scan failure | `scan-failed` |
| 512 MB/file hashing limit | `unhashed` |
| 200 file edges/step | `truncatedEdges` count |
| 4 KB tool arguments | Truncated preview |

Hidden/internal directories and dependency trees are excluded. Asynchronous
scans can combine neighboring effects; an exceptionally early write can enter
the initial baseline unnoticed. Size/mtime-preserving edits can evade change
detection. Files created outside the sandbox API have no user-operation root.
Shell internals remain opaque. Missing edges never prove that no work occurred.

## Storage and API

Steps are append-only JSONL at `.kady/provenance/<sessionId>/steps.jsonl`;
environment snapshots are content-addressed files in `.kady/environments/`.
User steps use the `user-actions` pseudo-session. Modal step IDs are stable per
job to avoid duplicate recovery records.

`GET /sandbox/provenance?path=<sandbox-relative>` with project scope returns
identity, producers/readers, citations, lineage and referenced environments.
Implementation: [`server/src/provenance/`](../server/src/provenance/).
These local records share the [same-user trust boundary](limitations.md#local-shell-trust-boundary).
