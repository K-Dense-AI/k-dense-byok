# Provenance

Provenance answers one question about any result Kady produces: **where did this
come from, and could I get it again?**

Open any file in the sandbox and click **Provenance** in the preview header. You
get the file's current content hash, the tool call that produced it, the inputs
that call read, the run and model responsible, and every lab-notebook entry that
cites it.

## What is recorded, and by whom

Provenance is **derived from observation, not from the agent's account of its own
work.** The agent has no tool that writes to the provenance log. Instead the run
loop watches the same event stream that drives the chat UI
(`server/src/provenance/recorder.ts`) and records what the agent's tools actually
did. This is deliberate: provenance is what you check the model against, so a
record the model could author would defeat its own purpose.

Each tool call becomes one append-only row in
`sandbox/.kady/provenance/<sessionId>/steps.jsonl` — the same layout family as
the cost ledger and the lab notebook. A row carries the tool name and arguments,
timing, the run id, the model in effect, and the sandbox files the call read and
wrote, each with a sha256.

## Edge confidence

Not every link can be established the same way, so every file edge is labelled
and the UI never flattens the distinction:

| Confidence | Meaning |
|---|---|
| **observed** | The tool named the file and its bytes were hashed afterward. |
| **inferred** | A sandbox scan attributed the change to this step, but a neighbouring step finished before the scan ran, so the file may belong to it instead. |
| **declared** | The model asserted the link and nothing verified it. |

How each tool class earns its level:

- `write` / `edit` name the file they touch, so the write is `observed` and needs
  no scan.
- `read` names its file, so the input edge is `observed`.
- `bash`, `subagent`, and unknown tools (including MCP tools) are opaque —
  `python de_analysis.py` is how most real scientific outputs get created, and
  only a before/after scan of the sandbox can see it. Normally `observed`;
  downgraded to `inferred` when attribution could be off (below).
- Tools known to be read-only (`grep`, `find`, `ls`, the web tools, `notebook`,
  `interview`, `scientific_result`) are recorded as steps with no file edges and
  trigger no scan.

## Staleness

Hashes exist mainly to make one specific hazard detectable. A notebook entry
citing `figure_3.png` is a claim about the bytes that existed when it was
written. Regenerate the figure after a bug fix and the citation silently points
at something else — the text still reads as if it describes the image.

The Provenance tab therefore reports:

- **Current** — the bytes on disk match what the producing step recorded.
- **Stale** — the file changed after the step that produced it.
- **Unverified** — no hash to compare against, so sameness was not checked.
  Size and mtime agreement alone does not earn "current".

Citations written before an artifact's latest version are flagged individually.

## Bounds and degradation

The scan is stat-only; hashing happens afterward and only for files that
actually moved. Dot-directories (`.kady`, `.pi`, `.git`, `.venv`) plus
`node_modules`, `__pycache__`, and `site-packages` are skipped, as are files the
sandbox already hides from users.

Where a limit applies, it is reported rather than hidden:

| Limit | Behaviour when exceeded |
|---|---|
| 20,000 files scanned | Step marked `sandbox-too-large`; file attribution incomplete. |
| Scan error (permissions, races) | Step marked `scan-failed`; file attribution incomplete. |
| 512 MB per file | Recorded with size and mtime, marked `unhashed`. |
| 200 file edges per step | Extra edges dropped, count reported as `truncatedEdges`. |
| 4 KB of tool arguments | Stored as a truncated preview. |

A step whose attribution degraded says so in the UI. Silent truncation would read
as "this step wrote nothing", which is a stronger claim than we can make.

## Known gaps

These are real and worth knowing before you rely on a record:

- **Scans are asynchronous.** A stat walk inside the event handler would stall
  SSE for every open tab, so scans run on a serialized queue. When two tool calls
  finish before the first one's scan runs, the diff cannot be split between them
  and the edges are marked `inferred` rather than guessed at.
- **The baseline can lose a very early write.** The recorder starts its baseline
  walk before the first model round-trip, which it normally wins. A `bash` call
  that both starts and finishes before that walk completes can have its writes
  folded into the baseline and go unrecorded.
- **Change detection is size-or-mtime.** A rewrite preserving both is invisible.
  The identity of what *is* reported is exact, because changed files are hashed.
- **Subagent steps are not yet harvested.** Child `pi` processes write their own
  session files; only the lead agent's steps are recorded in this version. The
  lab notebook already harvests child entries and provenance will follow the same
  route.
- **Environment is not captured yet.** Library versions, interpreter versions,
  and seeds are not recorded, so a step tells you *what ran* but not yet *in what
  environment*.
- **`bash` can still be opaque.** Provenance records what the sandbox looked like
  before and after a command, not what the command did internally. It is an
  observation of effects, not a sandbox-level audit — see
  [limitations](./limitations.md) for the related shell trust boundary.

## Storage

Rows live inside the project sandbox and travel with a project archive. They are
plain JSONL: one object per line, `schemaVersion` on every row, rows from a newer
schema ignored rather than half-parsed.

## API

`GET /sandbox/provenance?path=<sandbox-relative>` returns the artifact's current
identity, producing steps (newest first), the steps that read it, notebook
citations, and staleness. Project-scoped via `X-Project-Id`, because a figure
opened in one chat tab is routinely produced by another.
