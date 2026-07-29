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

## Subagent work

Delegated work is recorded too, but it is reconstructed rather than watched, and
the record says so.

A child `pi` process writes every tool call to its own session file. On
completion the parent parses that file and appends the steps to its own log —
the same hook the notebook harvest and the cost ledger already use. Harvested
steps carry `role: "subagent"` and the specialist's name, plus the child's own
model, which is often not the lead's.

Nothing is installed inside the child to make this work. The session file exists
whether or not the child knows it is being observed, which is what keeps
subagent provenance as unauthorable as the lead's.

Two things are weaker than for the lead agent, because the work is inspected
after it finished:

- **Bytes are hashed at harvest, not at write.** Every harvested artifact ref is
  marked `identityAt: "harvest"`, shown as "hashed later". A matching hash then
  only proves *unchanged since we looked* — so staleness reports **Unverified**
  rather than Current, and says why. A mismatch is still decisive.
- **`created` vs `modified` is unknowable**, since no before-state was seen.
  Harvested writes use `wrote` instead of guessing.

In practice those two weaknesses matter less than they sound, because harvested
steps *layer* on top of the lead's own record rather than replacing it. The
lead's `subagent` call is itself an opaque tool, so the lead's scan-diff already
saw the child's files appear and hashed them at the time. A delegated artifact
therefore usually ends up with two producing steps: the lead's `subagent` call,
`observed` with a write-time hash, and the child's own call, which names the
specialist and the exact tool. The write-time ref is the newer of the two, so
staleness still reports **Current**.

The harvest-time caveat only bites when the lead never observed the file — an
asynchronous child whose writes land outside any lead tool call, or a run whose
scan degraded. Which is exactly when you want to be told.

And `bash` inside a child cannot be scan-attributed at all — the sandbox has
moved on by the time the parent looks. Those steps are recorded with
`degraded: "no-scan-baseline"` so the gap is visible. To stop script-written
outputs from disappearing entirely, a file whose mtime falls inside the child's
activity window and which no recorded step already claims is attached to the
child's last opaque call as an **`inferred`** edge. The "already claimed" filter
is what prevents double-attribution: a synchronous subagent runs while the lead
executes nothing, and anything an asynchronous child's window overlaps that the
lead touched has already been claimed by the lead's own scan. The residual false
positive is two asynchronous children with overlapping windows — the file goes to
whichever is harvested first. `inferred` is load-bearing here.

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
| Opaque call inside a subagent | Step marked `no-scan-baseline`; any files are `inferred` by timing. |
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
- **Nested subagents are not harvested.** A subagent that itself delegates
  produces a grandchild session the parent never learns about, so depth > 1 is
  invisible — the same limit the lab notebook has.
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
