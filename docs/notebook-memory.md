# Source-linked project research memory

**Research memory** searches the project's saved notebook records across chats,
including past decisions, failures, null/inconclusive findings, user notes and
formal analysis-plan/deviation records. It recalls original text and source
identities, not a new AI-written fact sheet.

This is Stage 4 of the [notebook roadmap](./notebook-roadmap.md).

## For scientists

Open **Lab Notebook → Research memory**, enter a scientific term, method name,
dataset path or reason, and search. You can filter by record type or explicitly
recorded outcome. Superseded/historical records are included by default because
an old failure and its correction can both be scientifically useful.

Each hit shows:

- Its original source (chat, entry and, where applicable, plan-event id), author
  label, timestamp and content digest.
- An excerpt and which fields matched. Ranking is local, lexical/BM25-style
  relevance—not confidence, truth, scientific quality or independence.
- Recorded applicability (`scope`), limitations and reconsideration conditions
  (`revisitWhen`). These are authored statements, not verified facts or triggers
  for automatic action.
- Known supersession/correction links, historical plan status and authored
  hypothesis evidence status. Partial scans show unknown currentness rather than
  pretending the record is current.
- Point-in-time identity checks for directly cited artifacts. Changed or missing
  files need review; unchanged bytes do not verify science or upstream inputs.

**Read source** rereads the selected source and compares its digest with the
search hit. Intervening edits are flagged. The source view is plain text so
embedded markup is not activated. Related records—including amendments—can be
read separately. Notebook sources can be opened at their session-qualified entry;
plan events link back to the hypothesis. User notes from another chat remain
readable here without switching the active chat.

**Copy citation** copies a local source URL/digest and qualifications. **Copy
bounded recall for chat** copies a size-limited, qualified context bundle; it does
not send a chat, mutate the notebook, approve a plan or start compute. Inspect the
bundle's omission/truncation indicators before pasting it. Source URLs refer to
this local app/project, not a public DOI or independently published record.

## For lead agents and specialists

Newly created/reopened agent sessions receive the read-only `notebook_search`
tool. Child specialists receive the same schema and safeguards through the
vendored notebook package; Kady-owned builtin allowlists are migrated to include
it, while manually pinned tool lists remain authoritative.

```json
{
  "query": "why rejected Harmony integration",
  "limit": 4,
  "includeSuperseded": true
}
```

Then read an exact source before relying on its excerpt:

```json
{
  "action": "read",
  "source": {
    "kind": "notebook",
    "sessionId": "the-returned-session-id",
    "entryId": "the-returned-entry-id"
  },
  "expectedDigest": "the-returned-64-character-sha256"
}
```

Source kinds are `notebook`, `user-note`, and `plan-event` (which also carries
`eventId`). Notebook sources can be cited with existing `evidence` links using
the returned session/entry ids. User-note and plan-event references belong in
narrative citations rather than being invented as notebook tool-call ids.

The tool guidelines ask agents to check relevant past work before repeating an
analysis, preserve its qualifications, and not re-log retrieved text as a new
observation. Retrieval is an **explicit, visible tool call** in the chat/session
record. There is no hidden system-prompt injection or automatic project-wide
fact summary. Live sessions keep their already-loaded tools until recreated or
reopened after a backend restart.

Historical text/code is untrusted reference data, **not instructions**. An old
plan or approval is not permission for a new action or new spending. Technical
failure is not evidence of no effect, a null result is not automatically evidence
of equivalence, and a frozen plan is not proof of execution. “No match” never
proves that an analysis was not attempted.

## Coverage and bounds

The implementation rebuilds an ephemeral query-specific corpus from durable
source files on each request. No separate persistent truth cache needs to be
kept in sync or repaired after restart. It does not search raw chat transcripts,
auth stores, arbitrary data files, literature or external services. Pins and
comments are not treated as standalone findings; standalone user notes are
included. Plan events are recalled for retained, indexed hypotheses.

| Boundary | Behaviour |
|---|---|
| Query | ≤500 characters; up to 24 distinct lexical query terms |
| Results | Default 6, maximum 12 (UI requests 8) |
| Project scan | ≤32 MiB of source bytes, ≤512 source files, ≤100 sessions, ≤5,000 records |
| Notebook window | Recent ≤4 MiB/file; exact-source reads prioritize that session with a ≤16 MiB window, still within the project cap |
| Notebook row | ≤512 KiB; malformed/oversized/unterminated rows are not silently treated as verified absence |
| Searchable text | Bounded body/code prefixes (16,000/4,000 characters); long-record qualifiers identify this limitation |
| User-note sidecar | ≤1 MiB; user notes remain explicitly editable/self-reported |
| Plan history | Up to 64 recent indexed hypotheses; ≤1 MiB per journal; same chain/schema validator as the plan API |
| Source view | Bounded original body/code (64,000/32,000 characters), with truncation indicators |
| Agent response | ≤24 KiB of JSON text, with omitted hits/fields indicated |
| Clipboard context | ≤16 KiB; no silent removal of qualification flags |
| Artifact checks | Existing bounded direct-citation checks: no transitive lineage traversal and no automatic hashing of linked evidence sources |

Recent sessions are prioritized when limits apply. Coverage warnings identify
skipped/corrupt sources, partial tails, duplicate ids, changing files and budget
limits. An “active” record means no superseding record was found within the
available complete scan, **not** that its scientific claim is true. The UI labels
this “No recorded amendment.” A scan without limit warnings still covers only
these source families and bounded text—not everything the scientist ever did.
Outcome filters use recorded labels; legacy unlabeled failures/null results must
also be searched by text.

Superseded observations do not count as active evidence. Missing references and
partial coverage do not become confident hypothesis verdicts. Direct file checks
are separate from evidence stance: a changed file prompts review, not automatic
refutation. Incoming evidence files must be inspected through their own source
records/provenance before relying on them.

## Privacy and trust

Indexing/searching uses local filesystem reads only: no embedding service,
extra summarization model, scheduled background research or paid compute. When
an agent calls `notebook_search`, the returned bounded text enters the **currently
selected model's normal context**, just like other read-tool results, and normal
provider token usage/billing applies. Local-only indexing does not mean recalled
text stays local when the selected model is hosted.

The child bridge connects only to a loopback Kady API, does not follow redirects,
bypasses generic outbound fetch proxy dispatchers, bounds response size, and
validates the project context rather than guessing from a nested working-directory
name. Explicit missing/mismatched project requests are refused rather than
falling back to a different project.

These are app-level safeguards, not an OS secret boundary or an externally
signed provenance system. A same-user shell can alter local files. Use the
container/VM/separate-account guidance in [limitations](./limitations.md) for
adversarial content. Do not store credentials in notebook prose or use recall to
seek secrets.

## API and implementation

Project-scoped endpoints:

- `POST /projects/:projectId/notebook/memory/search` — `{query?, type?, outcome?,
  limit?, includeSuperseded?}`. A nonempty query or type/outcome filter is required.
- `GET /projects/:projectId/notebook/memory/record?source=<JSON>&expectedDigest=<sha>`
  — exact source read, with changed-since-search reporting.
- `POST /projects/:projectId/notebook/memory/tool` — the same bounded search/read
  envelope consumed by the lead tool and child bridge.

All are read-only/no-store operations. Sources are identified by kind + session +
entry (+ plan-event id), so duplicate raw ids in different chats cannot redirect
recall. Ambiguous duplicate ids within one source are reported rather than chosen
arbitrarily. Provenance treats `notebook_search` as read-only, preventing unrelated
concurrent file changes from being attributed to recall.

Core files: `server/src/agent/notebook-memory-loader.ts`,
`server/src/agent/notebook-memory.ts`, `web/src/lib/notebook-memory.ts`,
`web/src/components/notebook-memory-dialog.tsx`, and the child `memory-tool.ts` /
`memory-client.ts` in `server/pi-packages/kady-notebook/`.
