# Living Lab Notebook — Phase 5: Subagent Lanes — Design Spec

**Date:** 2026-07-05
**Status:** Approved (brainstorming), pending implementation plan
**Depends on:** Living Lab Notebook Phases 1–4 (shipped on `main`, spec `2026-07-05-living-lab-notebook-design.md`)

## One-line summary

Let **subagents** contribute to Kady's Living Lab Notebook: give child `pi`
processes a `notebook` tool via a Pi package, harvest their entries into the
parent notebook when each subagent completes, and render the notebook as
**per-agent collapsible lanes** (lead first, then each subagent) — so the
notebook visibly becomes a *team* lab book.

## Context and the constraint that shapes everything

Phases 1–4 gave the **lead** agent an in-process `notebook` custom tool
(`server/src/agent/notebook.ts`) whose entries persist to
`sandbox/.kady/notebook/<sessionId>.jsonl`, stream live over the parent SSE
(`tool_start` frames), and render in a center-panel `LabNotebookView`.

Subagents run as **separate `pi` CLI child processes** (via `pi-subagents`).
Two facts from investigating the installed SDK
(`@earendil-works/pi-coding-agent@0.79.0`) and `pi-subagents` govern this design:

1. **Child tool calls are recorded in the child's session JSONL.** A custom
   tool call appears as an assistant message with a `toolCall` content block
   carrying `name` and `arguments`. The parent already learns each child's
   `sessionFile` on completion — sync via `tool_result` `details.results[i]`
   and async via the `subagent:async-complete` event `results[i]` — each of
   which names the child's `agent` and `sessionFile`. This is exactly how
   `usageFromSessionFile` (`server/src/agent/subagent-bridge.ts`) already
   harvests child **cost**.
2. **There is no per-delegation env injection** into children (they inherit
   the server process env plus fixed `PI_SUBAGENT_*` bookkeeping keys), and a
   child's tool call **cannot ride the parent's SSE stream** (separate
   process). So subagent entries cannot stream token-by-token to the UI the
   way the lead's do.

**Consequence:** subagent entries surface **when the subagent completes**
(harvested from its session file), not live. That is an accepted trade-off,
not a bug.

Also relevant: a package-registered tool's `execute` receives a live
`ctx: ExtensionContext` (with `ctx.sessionManager.getSessionId()` /
`getSessionFile()` / `ctx.cwd`), and child processes carry a
`PI_SUBAGENT_CHILD` env marker — used below to avoid a tool-name collision.

## Decisions locked during brainstorming

1. **Entry timing:** batch on subagent completion (harvest from the child
   session file). Not near-live polling, not full IPC streaming.
2. **Layout:** per-agent **grouped collapsible lanes** (lead first, then each
   subagent), each its own mini-timeline. Not a tagged single timeline, not
   swim-lane columns.
3. **Architecture:** **env-gated package + completion harvest** (approach A) —
   the shipped in-process lead tool is left untouched; a new package provides
   the tool to children only; the parent harvests and remains the single
   writer.

## Architecture & data flow

```
LEAD agent (in-process)
  notebook tool (Phases 1–4, UNCHANGED)
    → writes parent notebook JSONL + emits tool_start SSE → live lead lane

SUBAGENT (child pi process)
  loads the kady-notebook Pi package (referenced from sandbox/.pi/settings.json,
    sandbox pre-trusted — same mechanism as pi-web-access)
  package registers the `notebook` tool ONLY when process.env.PI_SUBAGENT_CHILD is set
  child calls notebook({type,title,...}) → recorded in child session JSONL → tool returns an ack

PARENT (in-process), on subagent completion
  tool_result (sync) and subagent:async-complete (async) each provide {agent, sessionFile}
  for each child result:
    parse sessionFile for assistant toolCall content blocks where name === "notebook"
    build NotebookEntry per call: role = agent name, id = "<agent>:<childToolCallId>",
      timestamp = message timestamp, fields from arguments
    append to the PARENT notebook JSONL (dedup by id)

FRONTEND
  on a tool_end frame where toolName === "subagent", re-GET /sessions/:id/notebook
  merge (dedupe by id) → LabNotebookView groups entries by role into
    collapsible lanes: lead ("agent") first, then each subagent by first-entry time
```

The **parent is the single writer** to every notebook file — parallel
subagents completing at once are appended serially by the single-threaded
parent, so there is no concurrent-append corruption and no reliance on a
best-effort parent-session-id path heuristic.

## Components

### New: `kady-notebook` Pi package (vendored in-repo)

- Location: `server/pi-packages/kady-notebook/` (a directory referenced by
  absolute path from `sandbox/.pi/settings.json` `packages`).
- `package.json`: `{ name, private:true, keywords:["pi-package"],
  "pi": { "extensions": ["./index.ts"] }, peerDependencies:
  { "@earendil-works/pi-coding-agent": "*", "typebox": "*" } }` (peers not
  bundled). Import from `@earendil-works/pi-coding-agent` (the scope actually
  installed here), not the legacy `@mariozechner/*` alias.
- `index.ts`: default-export `ExtensionFactory`:
  ```
  export default function (pi) {
    if (!process.env.PI_SUBAGENT_CHILD) return;   // parent loads this but registers nothing
    pi.registerTool(notebookTool);
  }
  ```
- The child `notebook` tool: **same typebox schema** as the lead tool
  (type/title/body/artifacts/code/confidence/tags) and the same
  `promptGuidelines`, but its `execute` only validates a non-empty title and
  returns a small ack — it writes no file. The call + args are captured in the
  child's session JSONL by Pi; the parent harvests them. Schema is defined
  self-contained in the package (a unit test asserts its accepted shape matches
  the backend `NotebookEntryInput`).

### New: `server/src/agent/notebook-harvest.ts`

- `notebookEntriesFromSessionFile(sessionFile: string, agentName: string):
  NotebookEntry[]` — reads the child session JSONL, finds assistant messages
  whose `content[]` includes `{ type:"toolCall", name:"notebook", id, arguments }`,
  and maps each to a `NotebookEntry` with `role = agentName`, `timestamp =
  <message timestamp, else harvest time>`, and the entry fields defensively
  coerced from `arguments` (same guards as the frontend `parseNotebookFrame`).
  Missing/unreadable file → `[]`; malformed row or args → skipped. Pure and
  independently testable (mirrors `usageFromSessionFile`).
- **Entry `id` (collision-safe).** Harvested entries are namespaced so they can
  never collide with the lead's entries (whose `id` is the lead's toolCall id)
  or with another subagent's during the frontend's dedupe-by-`id` merge: `id =
  \`${agentName}:${childToolCallId}\`` (child toolCall ids are unique within a
  child stream; the agent-name prefix defends the rare cross-stream case and is
  stable across re-delivery so the parent's dedup `Set` keyed on this id works).

### New: `server/src/agent/notebook-bridge.ts`

- `seedNotebookPackage(paths)` — appends the `kady-notebook` package's absolute
  dir to `sandbox/.pi/settings.json` `packages`, mirroring
  `seedWebAccessPackage` (parse-tolerant; leaves an unparseable settings file
  untouched). Sandbox **trust** is already established by the existing
  `ensureWebAccess(paths)` call in `build()`, so no separate trust write is
  needed (documented in the module).
- `makeSubagentNotebookExtension(projectId, getSessionId): ExtensionFactory` —
  registers `pi.on("tool_result")` and `pi.events.on("subagent:async-complete")`
  handlers that, for each child result with an `agent` name and `sessionFile`,
  call `notebookEntriesFromSessionFile` and `appendNotebookEntry` into the
  **parent** notebook (parent sessionId via `getSessionId()`). A module-level
  dedup `Set` keyed by the namespaced entry `id` (`<agent>:<childToolCallId>`)
  prevents double-appends when an async completion is delivered to multiple
  live sessions (mirrors the ledger's `ledgeredAsyncRuns`, including its
  size cap).

### Changed: `server/src/agent/session-registry.ts`

- In `build()`: call `seedNotebookPackage(paths)` (next to `ensureWebAccess`)
  and add `makeSubagentNotebookExtension(projectId, () => holder.session?.sessionId ?? "")`
  to the `DefaultResourceLoader` `extensionFactories` (next to the ledger
  extension). The in-process lead `notebook` tool registration is **unchanged**.

### Changed: frontend — refresh signal + lanes

- `web/src/lib/use-agent.ts`: add a `subagentCompletions: number` counter,
  incremented whenever a `tool_end` frame with `toolName === "subagent"` is
  seen in the live loop; expose it in the hook's return. (Cleared on `reset`.)
- `web/src/components/chat-tab.tsx`: add `subagentCompletions` to `ChatTabMeta`
  and the `onMetaChange` payload + its effect deps.
- `web/src/app/page.tsx`: thread the active tab's `subagentCompletions` into
  `FilePreviewPanel` → `LabNotebookView` as a prop.
- `web/src/components/lab-notebook-view.tsx`:
  - Re-GET `/sessions/:id/notebook` when `subagentCompletions` changes (in
    addition to on `sessionId` change), so harvested child entries appear.
  - **Group** the merged entries by `role` into lanes: the lead (`role ===
    "agent"`) renders first, labeled "Kady (lead)"; each other role becomes a
    collapsible section (ordered by its earliest entry's timestamp) with a
    colored header and its own mini-timeline of `LabNotebookEntryCard`s. With
    no subagent entries the view renders exactly as today (a single lead lane).

## Error handling & edge cases

- Missing/unreadable child session file → harvest returns `[]`; malformed
  JSONL rows or tool args → that entry skipped (never throws).
- Duplicate delivery of an async completion → dedup `Set` on the namespaced
  entry `id` (`<agent>:<childToolCallId>`).
- **Nested subagents (depth > 1):** v1 harvests **direct** children only.
  A nested child's entries will not appear; the async payload's
  `nestedChildren` is the future extension point. Documented as a limitation.
- Parallel subagents finishing simultaneously → serial `appendFileSync` on the
  single-threaded parent → no corruption.
- Name collision: the `PI_SUBAGENT_CHILD` env-gate guarantees the parent
  session loads the package but registers no tool, so it keeps exactly one
  `notebook` tool (its in-process one).
- A subagent that logs nothing → no lane for it (fine).
- If the package fails to load or a child predates the package → the child
  simply cannot log entries; the lead notebook still works.

## Testing

- **`notebook-harvest.test.ts`** (server/vitest): fixture child session JSONL
  containing `notebook` toolCalls → correct role-stamped entries in order;
  malformed rows skipped; missing file → `[]`; a non-notebook toolCall ignored.
- **Package** (server/vitest): the extension factory registers the tool only
  when `PI_SUBAGENT_CHILD` is set (and registers nothing otherwise); the tool
  rejects an empty title and returns an ack; a schema-parity assertion against
  `NotebookEntryInput`.
- **Bridge** (server/vitest): a simulated `tool_result` and a simulated
  `subagent:async-complete`, each carrying a fixture `sessionFile`, append the
  expected deduped entries to the parent notebook store (second delivery is a
  no-op).
- **Frontend** (web/vitest): `LabNotebookView` renders grouped lanes for a
  lead + two subagent roles (collapsible, lead first), re-fetches when the
  `subagentCompletions` prop increments, and still renders a single lead lane
  when there are no subagent entries.
- Server + web suites green; `tsc --noEmit` clean both sides; production web
  build clean. Manual/e2e agent runs only with Opus 4.8 or GPT-5.5.
- Baseline reminder: the two pre-existing web jsdom failures
  (`projects.test.ts`, `pdf-annotations.test.ts`) are not regressions.

## Phasing (one implementation plan)

1. `notebook-harvest.ts` + tests (pure; no wiring).
2. `kady-notebook` Pi package (env-gated registration) + tests.
3. `notebook-bridge.ts` (`seedNotebookPackage` + `makeSubagentNotebookExtension`)
   and wire both into `session-registry.build()`; dedup.
4. Frontend `subagentCompletions` refresh signal (useAgent → ChatTabMeta →
   page → view) + re-GET on change.
5. Grouped-lane rendering in `LabNotebookView`.
6. Docs: update the `AGENTS.md` notebook caveat (now reaches subagents via the
   package; entries harvested on completion) and `docs/lab-notebook.md` (lanes).

## Out of scope (v1)

- Near-live / streaming subagent entries (batch-on-completion only).
- Nested-subagent (depth > 1) harvesting.
- A "working…" pending lane placeholder for an in-flight subagent (optional
  nice-to-have; the plan may include it only if trivial from the subagent
  `tool_start` args).
- Editing/attributing entries by hand.
