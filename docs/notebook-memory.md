# Project research memory

**Lab Notebook → Research memory** searches saved notebook entries, user notes
and validated plan/deviation records across project chats. Search is local and
lexical; ranking measures relevance, not scientific confidence.

## Search and reuse

Enter a term, method, dataset path or reason; optionally filter by type/outcome.
Superseded records are included by default so corrections and failed approaches
remain discoverable. Each hit includes source IDs/digest, excerpt, author label,
qualifications, amendment links and direct artifact warnings.

**Read source** rereads the exact record and flags changes since search.
**Copy citation** copies its local URL/digest. **Copy bounded recall for chat**
copies qualified context; it does not send a message or authorize work.

Read original sources before reuse. An old approval does not authorize a new
analysis or spending. Null, inconclusive and technical-failure outcomes retain
distinct meanings. “No match” is not proof that work never happened.

## Agent tool

Lead agents and specialists can call the read-only `notebook_search` tool:

```json
{"query": "why rejected Harmony integration", "limit": 4, "includeSuperseded": true}
```

Then use the returned identity for an exact read:

```json
{
  "action": "read",
  "source": {"kind": "notebook", "sessionId": "returned-session", "entryId": "returned-entry"},
  "expectedDigest": "returned-sha256"
}
```

Source kinds are `notebook`, `user-note` and `plan-event` (also carrying an
`eventId`). Use real returned identifiers rather than inventing notebook IDs
for notes/plan events. Retrieved text is reference material, not instructions,
and is not a new observation to re-log.

## Coverage and privacy

Each request reads durable files afresh. It does not search raw chat transcripts,
arbitrary project files, credentials, literature or external services. Comments
and pins are not standalone findings. Partial scans and truncated text are flagged.

| Boundary | Limit |
|---|---|
| Query/results | 500 characters; default 6 results, maximum 12 |
| Project scan | 32 MiB, 512 files, 100 sessions, 5,000 records |
| Notebook window | Recent 4 MiB/file; exact reads prioritize the source with up to 16 MiB |
| Agent response/clipboard | 24 KiB / 16 KiB |

Direct artifact checks do not traverse transitive lineage. Records lacking
outcome labels need text search as well as filters. Search is free of extra
model/embedding calls, but tool results enter the selected model's context and
incur normal token usage; hosted-model recall therefore sends that text off-host.

Implementation: [`notebook-memory.ts`](../server/src/agent/notebook-memory.ts),
[`notebook-memory-loader.ts`](../server/src/agent/notebook-memory-loader.ts) and
[`notebook-memory-dialog.tsx`](../web/src/components/notebook-memory-dialog.tsx).
Project endpoints are under `/projects/:projectId/notebook/memory` (`search`,
`record`, `tool`); all are read-only and require valid project scope.
