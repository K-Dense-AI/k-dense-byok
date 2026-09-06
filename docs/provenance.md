# Provenance

Provenance answers one question about any result Kady produces: **where did this
come from, and could I get it again?**

Open any file in the sandbox and click **Provenance** in the preview header. You
get the file's current content hash, its lineage back to the data you uploaded,
the tool call that produced it, the inputs that call read, the run, model and
environment responsible, and every lab-notebook entry that cites it.

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

## Who performs a step

Every row carries a `role`, and the panel names the actor in words:

| Role | Recorded how |
|---|---|
| **lead agent** | Observed live from the run's event stream. |
| **subagent** | Reconstructed from the child's session file on completion (below). |
| **you** | The sandbox file API records its own effects: `upload`, editor `save`, `move`, `delete`. Written by the server as it performs the operation and hashed at that moment, so the model still cannot author them. They live in a reserved `user-actions` pseudo-session. |
| **remote compute** | A durable Modal job, recorded at its terminal transition from the transfer layer's own staging/collection hashes (below). |

User steps exist because every chain of analysis ends at a file somebody
uploaded, and without a record of the upload the root of every lineage read "no
recorded provenance" — indistinguishable from a file of unknown origin. They also
explain what used to look like corruption: an editor save turned an artifact
**Stale** with nothing in its history to say why. Now the save is the newest
producing step, the overwritten version is its input, and the artifact is
**Current** again.

## Lineage

The panel's **Lineage** section walks upstream through input edges: the figure,
the script and table that produced it, the raw data those were derived from,
down to the upload. Each hop is **version-aware** — it picks the producer of the
version that was actually consumed (the newest step that wrote the input at or
before the consuming step ran), not the newest producer overall. So a figure
built from Tuesday's `counts.csv` points at Tuesday's step even after the table
was regenerated on Wednesday, and the node is flagged **changed since use**:
the bytes on disk are not what the figure was built from, so re-running the
step would not reproduce it.

Where a chain ends is stated: **uploaded** (the natural origin), **created by
you** (an editor-made file with no recorded inputs), **no recorded origin** (the
consumed version predates recording, arrived outside the API, or its producing
scan degraded), or **walk stopped** (the 60-node / 12-hop budget). A user
`move` records the source as an input, so the walk passes straight through a
rename to the original producer.

### Inputs of opaque calls

`python de_analysis.py counts.csv` reads two files and the sandbox scan sees
neither — a read leaves nothing on disk. Lineage used to break at exactly the
step that does the science. The command line is the best available witness, so
an opaque call now gets an **`inferred`** input edge for every token that names
a file which existed before the call and which the call did not write. The
script and its data both qualify; a redirect target does not (it shows up as an
output). Quoting, `./` prefixes and `--flag=path` are handled; globs, variables
and `..` are not resolved. This is evidence, not observation, and the edges say
so; a harvested subagent's `bash` gets the same treatment against files that
predate the call's timestamp.

## Environment

A step used to tell you *what ran* but not *in what*. The recorder now captures
the sandbox's execution environment at the start of every run, stamps each step
with its id, and re-captures after any step that changed it. Change is detected
two ways: an `install`-shaped command (`uv add`, `pip install`,
`install.packages`, …), and a cheap stat fingerprint of the lockfiles, the
venv's `pyvenv.cfg` and its `site-packages` directories taken after every opaque
call — which is what catches `uv run` silently creating or syncing the venv,
since `uv.lock` and `.venv` are both invisible to the sandbox scan. A step
carries the environment it started *from*; the one after `uv add scanpy`
carries the new one.

What a snapshot holds, and what it costs:

- **Python** — version from the uv venv's `pyvenv.cfg`, packages from the
  `*.dist-info` directory names in `site-packages`. No subprocess. Without a
  sandbox venv, the system `python3` version is recorded and no package list.
- **R** — version and installed packages via one `Rscript` call, only when
  Rscript is on PATH, bounded by a timeout. Not `--vanilla`, so an renv project
  reports its activated library.
- **Lockfiles** — sha256 of `uv.lock`, `pyproject.toml`, `requirements*.txt`,
  `environment.yml`, `renv.lock`, `DESCRIPTION`, `Project.toml`, `Manifest.toml`
  at the sandbox root. The declarative environment a reader reproduces from.
- **Git HEAD** of the sandbox, if it is a repository, read from `.git` directly.
- **OS** platform/release/arch and the `uv` version.

Snapshots are content-addressed — `id` is the sha256 of everything but the
capture time — and stored once under `sandbox/.kady/environments/<id>.json`, so
a hundred runs against an unchanged venv share one record. The panel shows a
one-line summary per step ("Python 3.12.4 · 143 packages · uv.lock a1b2c3d4")
that expands to the full list. Harvested subagent steps carry the environment
captured *at harvest* and are marked "(captured later)", since the child may
have changed it in between. Remote Modal steps carry no snapshot; their image
and named environment are recorded on the step instead.

## Remote compute

A Modal job is the one kind of step whose file effects are measured exactly
without a scan: `stageInputs` hashes every input as it uploads it and
`collectOutputs` hashes every output as it installs it. When a job reaches a
terminal state the manager records one `compute` step in the owner session's
log, with those hashes as **observed, write-time** identities — no "hashed
later" caveat — plus the remote command, instance, GPU, exit code, image or
named environment, sandbox id, and any requested outputs the job never
produced. Failed, cancelled and lost jobs are recorded too, as errors, so the
attempt is visible. The step id is stable per job, so restart recovery cannot
double-record.

The lead's own `modal_run`/`modal_wait` call is still recorded as an opaque
tool whose scan-diff sees the outputs land, so a remote artifact typically has
two producing steps, as delegated artifacts do: the agent's call, and the job
that names what actually ran where.

## Edge confidence

Not every link can be established the same way, so every file edge is labelled
and the UI never flattens the distinction:

| Confidence | Meaning |
|---|---|
| **observed** | The tool named the file and its bytes were hashed afterward. |
| **inferred** | Attributed from evidence rather than direct observation: a sandbox scan that could not be split between neighbouring steps, or an input the command line named that existed beforehand. |
| **declared** | The model asserted the link and nothing verified it. |

How each tool class earns its level:

- `write` / `edit` name the file they touch, so the write is `observed` and needs
  no scan.
- `read` names its file, so the input edge is `observed`.
- `bash`, `subagent`, and unknown tools (including MCP tools) are opaque —
  `python de_analysis.py` is how most real scientific outputs get created, and
  only a before/after scan of the sandbox can see it. Outputs are normally
  `observed`, downgraded to `inferred` when attribution could be off (below);
  inputs, taken from the command line, are always `inferred`.
- User steps (`upload`, `save`, `move`, `delete`) and Modal `compute` steps
  are `observed`: the server or the transfer layer hashed the bytes as it
  handled them.
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
- **Lineage keeps one version per path.** If two steps in the walk consumed
  different versions of the same input, the first-reached consumer's version is
  the one shown.
- **Environment capture is a snapshot, not a trace.** It records the venv and
  lockfiles as they stood when the run (or the re-capture) began; a script that
  installs a package mid-execution and uses it in the same command runs in an
  environment the snapshot predates. Random seeds and hardware are not
  recorded.
- **Inferred inputs are only as good as the command line.** A script that opens
  a hard-coded path, reads a config that names further files, or takes its
  input from a glob has inputs the command never mentions. Lineage through such
  a step stops at the script.
- **User steps see the API, not the disk.** A file dropped into the sandbox
  directory by a terminal or a sync client is not an upload and gets no root.
- **`bash` can still be opaque.** Provenance records what the sandbox looked like
  before and after a command, not what the command did internally. It is an
  observation of effects, not a sandbox-level audit — see
  [limitations](./limitations.md) for the related shell trust boundary.

## Storage

Rows live inside the project sandbox and travel with a project archive. They are
plain JSONL: one object per line, `schemaVersion` on every row, rows from a newer
schema ignored rather than half-parsed. Environment snapshots sit beside them in
`.kady/environments/`, one JSON file per distinct environment. New optional
fields (`environmentId`, `compute`, the `user`/`compute` roles) were added
without a schema bump: an older build reads such a row and simply shows less.

## API

`GET /sandbox/provenance?path=<sandbox-relative>` returns the artifact's current
identity, producing steps (newest first), the steps that read it, notebook
citations, staleness, the upstream `lineage` (nodes, edges, and the steps they
reference), and `environments` — every snapshot referenced by a returned step,
keyed by id. Project-scoped via `X-Project-Id`, because a figure opened in one
chat tab is routinely produced by another.
